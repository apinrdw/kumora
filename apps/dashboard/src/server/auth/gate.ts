// The sign-in gate for pages and server functions: read the session through
// Auth, ask the access policy, and map a denial to the closed HttpError set
// (spec apinrdw/kumora#80, "The gate in pages and server functions").
import { Forbidden, NotFound, Unauthorized } from "@workspace/server"
import { Effect } from "effect"

import { withRedirect } from "@/lib/redirect"

import { Auth } from "./auth.ts"
import { FEATURES, decide, type Feature, type Reason } from "./policy.ts"
import { accountOf } from "./session-account.ts"

export interface Viewer {
  readonly name: string
  readonly email: string
  // The features whose pages this account may view; the nav shows only these.
  readonly features: ReadonlyArray<Feature>
  // An admin is viewing as this account; every page shows the banner.
  readonly impersonating: boolean
}

// NotFound is a value here, not the HttpError: the layout shows the normal
// not-found page inside the shell, which needs the viewer.
type PageAccess =
  | { readonly _tag: "Allowed"; readonly viewer: Viewer }
  | { readonly _tag: "NotFound"; readonly viewer: Viewer }
  | {
      readonly _tag: "NoAccess"
      readonly viewer: Viewer
      readonly feature: Feature
    }

export interface Page {
  // Path and search of the page asked for; the visitor returns to it.
  readonly href: string
  readonly feature: Feature
}

export const refusal = (reason: Exclude<Reason, "no-access">, href: string) => {
  switch (reason) {
    // A suspended account holds no session, so it lands on sign-in, which
    // shows the suspended screen when Better Auth refuses it.
    case "sign-in":
    case "suspended":
      return new Unauthorized({ redirectTo: withRedirect("/sign-in", href) })
    case "verify":
      return new Unauthorized({ redirectTo: withRedirect("/verify", href) })
    case "not-found":
      return new NotFound({ message: "" })
    case "forbidden":
      return new Forbidden({ message: "" })
  }
}

export const gatePage = Effect.fn("gatePage")(function* (
  headers: Headers,
  { href, feature }: Page
) {
  const auth = yield* Auth
  // Admin pages read past the cookie cache, so admin power always sees the
  // current role and ban state.
  const session = yield* auth.getSession(headers, {
    fresh: feature === "admin",
  })
  const account = accountOf(session)
  const decision = decide(account, "page.view", { feature })
  if (
    decision._tag === "Deny" &&
    decision.reason !== "no-access" &&
    decision.reason !== "not-found"
  )
    return yield* refusal(decision.reason, href)
  // Unreachable: the policy sends every visitor without a session to sign-in.
  if (session === null) return yield* refusal("sign-in", href)
  const viewer: Viewer = {
    name: session.user.name,
    email: session.user.email,
    features: FEATURES.filter(
      (each) => decide(account, "page.view", { feature: each })._tag === "Allow"
    ),
    impersonating: session.session.impersonated,
  }
  if (decision._tag === "Allow")
    return { _tag: "Allowed", viewer } satisfies PageAccess
  return decision.reason === "not-found"
    ? ({ _tag: "NotFound", viewer } satisfies PageAccess)
    : ({ _tag: "NoAccess", viewer, feature } satisfies PageAccess)
})

// The full-page verify screen. It reads past the cookie cache, so an account
// verified in another browser goes on to its page at once.
export const verifyScreen = Effect.fn("verifyScreen")(function* (
  headers: Headers,
  href: string
) {
  const auth = yield* Auth
  const session = yield* auth.getSession(headers, { fresh: true })
  // The verify screen belongs to the account itself.
  const decision = decide(accountOf(session), "page.view", {
    feature: "account",
  })
  if (decision._tag === "Deny" && decision.reason === "verify" && session)
    return { _tag: "Unverified", email: session.user.email } as const
  if (
    decision._tag === "Deny" &&
    (decision.reason === "sign-in" || decision.reason === "suspended")
  )
    return yield* refusal(decision.reason, href)
  // Anything else is the page's own gate to answer.
  return yield* new Unauthorized({ redirectTo: href })
})
