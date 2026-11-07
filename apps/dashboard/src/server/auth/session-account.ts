// What the gates read of a Better Auth session, and the access policy's
// Account built from it. Pure, so the Better Auth hooks and the page gates
// build the same Account.
import { signedOut, type Account, type Role, type SignedOut } from "./policy.ts"

export interface AuthSession {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
    readonly role: Role
    readonly banned: boolean
    // An admin whose email is on ADMIN_EMAILS.
    readonly configAdmin: boolean
  }
  readonly session: {
    readonly id: string
    // An admin is viewing as this account.
    readonly impersonated: boolean
  }
}

// A session as Better Auth hands it over, with the admin plugin's fields.
export interface BetterAuthSession {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
    readonly role?: unknown
    readonly banned?: unknown
  }
  readonly session: {
    readonly id: string
    readonly impersonatedBy?: unknown
  }
}

// Fails closed: any stored role but admin reads as a member.
export const roleOf = (stored: unknown): Role =>
  stored === "admin" ? "admin" : "member"

export const authSessionOf = (
  { user, session }: BetterAuthSession,
  onAdminList: (email: string) => boolean
): AuthSession => {
  const role = roleOf(user.role)
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      role,
      banned: user.banned === true,
      configAdmin: role === "admin" && onAdminList(user.email),
    },
    session: { id: session.id, impersonated: Boolean(session.impersonatedBy) },
  }
}

export const accountOf = (session: AuthSession | null): Account | SignedOut =>
  session === null
    ? signedOut
    : {
        _tag: "Account",
        role: session.user.role,
        verified: session.user.emailVerified,
        suspended: session.user.banned,
        configAdmin: session.user.configAdmin,
        impersonating: session.session.impersonated,
      }
