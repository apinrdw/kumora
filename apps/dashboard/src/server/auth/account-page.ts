// What `/account` shows: the account, its sign-in methods and sessions, and
// which own-account actions the access policy allows it now. While
// impersonating, the policy allows none, so the page is read-only.
import { Forbidden } from "@workspace/server"
import { Effect } from "effect"

import { device } from "@/lib/device"

import { Auth } from "./auth.ts"
import { refusal } from "./gate.ts"
import { OWN_ACCOUNT, decide, type OwnAction, type Role } from "./policy.ts"
import { accountOf } from "./session-account.ts"

export type SignInMethod = "password" | "google"

const METHOD: Readonly<Partial<Record<string, SignInMethod>>> = {
  credential: "password",
  google: "google",
}

export interface SessionRow {
  readonly id: string
  // What Better Auth's revoke-session takes.
  readonly token: string
  readonly device: string
  readonly ipAddress: string | null
  readonly lastActive: string
  // The session of the browser showing the page.
  readonly current: boolean
}

export interface AccountPage {
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly signInMethods: ReadonlyArray<SignInMethod>
  // The current session first, then the most recently active.
  readonly sessions: ReadonlyArray<SessionRow>
  readonly allowed: Readonly<Record<OwnAction, boolean>>
  // Why the policy refuses change email and delete: the reason line names it.
  readonly configAdmin: boolean
}

// Reads past the cookie cache: the page lists sessions, so a session ended
// elsewhere must not see it.
export const accountPage = Effect.fn("accountPage")(function* (
  headers: Headers,
  href: string
) {
  const auth = yield* Auth
  const session = yield* auth.getSession(headers, { fresh: true })
  const account = accountOf(session)
  const decision = decide(account, "page.view", OWN_ACCOUNT)
  if (decision._tag === "Deny")
    return yield* decision.reason === "no-access"
      ? new Forbidden({ message: "" })
      : refusal(decision.reason, href)
  // Unreachable: the policy sends every visitor without a session to sign-in.
  if (session === null || account._tag === "SignedOut")
    return yield* refusal("sign-in", href)

  const [stored, providers] = yield* Effect.all([
    auth.sessionsOf(session.user.id),
    auth.providersOf(session.user.id),
  ])
  const sessions = stored
    .map((each): SessionRow => ({
      id: each.id,
      token: each.token,
      device: device(each.userAgent),
      ipAddress: each.ipAddress || null,
      lastActive: each.updatedAt.toISOString(),
      current: each.id === session.session.id,
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.lastActive.localeCompare(a.lastActive)
    )
  const allowed = (action: OwnAction) =>
    decide(account, action, OWN_ACCOUNT)._tag === "Allow"
  return {
    email: session.user.email,
    name: session.user.name,
    role: account.role,
    signInMethods: providers.flatMap((provider) => METHOD[provider] ?? []),
    sessions,
    allowed: {
      "own.update-profile": allowed("own.update-profile"),
      "own.change-password": allowed("own.change-password"),
      "own.end-sessions": allowed("own.end-sessions"),
      "own.change-email": allowed("own.change-email"),
      "own.delete": allowed("own.delete"),
    },
    configAdmin: account.configAdmin,
  } satisfies AccountPage
})
