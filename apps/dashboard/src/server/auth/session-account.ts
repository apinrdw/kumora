// What the gates read of a Better Auth session, and the access policy's
// Account built from it. Pure, so the Better Auth hooks and the page gates
// build the same Account.
import { signedOut, type Account, type SignedOut } from "./policy.ts"

// Later plugins widen it (role, banned, impersonatedBy).
export interface AuthSession {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
  }
  readonly session: { readonly id: string }
}

// Until the admin plugin (apinrdw/kumora#86) puts role and ban state on the
// session, every account is a member that isn't suspended.
export const accountOf = (session: AuthSession | null): Account | SignedOut =>
  session === null
    ? signedOut
    : {
        _tag: "Account",
        role: "member",
        verified: session.user.emailVerified,
        suspended: false,
        configAdmin: false,
        impersonating: false,
      }
