// What the gates read of a Better Auth session, and the access policy's
// Account built from it. Pure, so the Better Auth hooks and the page gates
// build the same Account.
import { DateTime, Effect } from "effect"

import {
  signedOut,
  type Account,
  type Role,
  type SignedOut,
  type Target,
} from "./policy.ts"

export interface AuthSession {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
    readonly role: Role
    readonly banned: boolean
    // A verified account whose email is on ADMIN_EMAILS; always an admin.
    readonly configAdmin: boolean
  }
  readonly session: {
    readonly id: string
    // An admin is viewing as this account.
    readonly impersonated: boolean
    // When the session expires. An impersonation session's is at most an
    // hour from its creation (options.ts holds the hour).
    readonly expiresAt: DateTime.Utc
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
    readonly expiresAt: Date
    readonly impersonatedBy?: unknown
  }
}

// Fails closed: any stored role but admin reads as a member.
export const storedRoleOf = (stored: unknown): Effect.Effect<Role> =>
  Effect.succeed(stored === "admin" ? "admin" : "member")

// The configured admin list, ADMIN_EMAILS (admin-emails.ts).
export interface AdminList {
  // Lower-cased: match an email lower-cased, and a query filters by the
  // effective role with them.
  readonly emails: ReadonlyArray<string>
}

// Whether `email` is on the admin list, in any case.
export const onAdminList = (
  adminList: AdminList,
  email: string
): Effect.Effect<boolean> =>
  Effect.succeed(adminList.emails.includes(email.toLowerCase()))

// A verified account whose email is on ADMIN_EMAILS. Not the stored role: an
// email put on the list after it was verified is a config admin at once.
const isConfigAdmin = Effect.fnUntraced(function* (
  user: { readonly email: string; readonly emailVerified: boolean },
  adminList: AdminList
) {
  return user.emailVerified && (yield* onAdminList(adminList, user.email))
})

// A config admin is an admin whatever role is stored; the grant stores it at
// its next sign-in (callbacks.ts).
const roleOf = (stored: unknown, configAdmin: boolean): Effect.Effect<Role> =>
  configAdmin ? Effect.succeed("admin") : storedRoleOf(stored)

export const authSessionOf = Effect.fnUntraced(function* (
  { user, session }: BetterAuthSession,
  adminList: AdminList
): Effect.fn.Return<AuthSession> {
  const configAdmin = yield* isConfigAdmin(user, adminList)
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      role: yield* roleOf(user.role, configAdmin),
      banned: user.banned === true,
      configAdmin,
    },
    session: {
      id: session.id,
      impersonated: Boolean(session.impersonatedBy),
      expiresAt: DateTime.makeUnsafe(session.expiresAt),
    },
  }
})

// An account as stored, with the admin plugin's fields.
type StoredUser = Pick<
  BetterAuthSession["user"],
  "id" | "email" | "emailVerified" | "role" | "banned"
>

// The account an admin action acts on, as the access policy reads it.
export const targetOf = Effect.fnUntraced(function* (
  user: StoredUser,
  actor: AuthSession | null,
  adminList: AdminList
): Effect.fn.Return<Target> {
  const configAdmin = yield* isConfigAdmin(user, adminList)
  return {
    role: yield* roleOf(user.role, configAdmin),
    configAdmin,
    isSelf: user.id === actor?.user.id,
    suspended: user.banned === true,
  }
})

// The account itself, acting through an emailed link that works from any
// browser: built from the stored account, with only whether an admin is
// viewing as it taken from the request's session.
export const accountOfUser = Effect.fnUntraced(function* (
  user: StoredUser,
  impersonated: boolean,
  adminList: AdminList
): Effect.fn.Return<Account> {
  const configAdmin = yield* isConfigAdmin(user, adminList)
  return {
    _tag: "Account",
    role: yield* roleOf(user.role, configAdmin),
    verified: user.emailVerified,
    suspended: user.banned === true,
    configAdmin,
    impersonating: impersonated,
  }
})

export const accountOf = (
  session: AuthSession | null
): Effect.Effect<Account | SignedOut> =>
  Effect.succeed(
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
  )
