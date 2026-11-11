// The sign-in gate for pages and server functions: read the session through
// Auth, ask the access policy, and map a denial to the closed HttpError set
// (spec apinrdw/kumora#80, "The gate in pages and server functions") through
// refusal.ts.
import { Unauthorized } from "@workspace/server"
import { Effect } from "effect"

import { Auth } from "./auth.ts"
import { FEATURES, decide, type Feature } from "./policy.ts"
import { refusal } from "./refusal.ts"
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
  const account = yield* accountOf(session)
  const decision = yield* decide(account, "page.view", { feature })
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
    features: yield* Effect.filter(FEATURES, (each) =>
      Effect.map(
        decide(account, "page.view", { feature: each }),
        (allowed) => allowed._tag === "Allow"
      )
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
  const decision = yield* decide(yield* accountOf(session), "page.view", {
    feature: "account",
  })
  if (decision._tag === "Deny" && decision.reason === "verify" && session)
    return {
      _tag: "Unverified",
      email: session.user.email,
      // An admin may view as an unverified member; the screen keeps the
      // banner, and Stop with it.
      impersonating: session.session.impersonated,
    } as const
  if (
    decision._tag === "Deny" &&
    (decision.reason === "sign-in" || decision.reason === "suspended")
  )
    return yield* refusal(decision.reason, href)
  // Anything else is the page's own gate to answer.
  return yield* new Unauthorized({ redirectTo: href })
})
