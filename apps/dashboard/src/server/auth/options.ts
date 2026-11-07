// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions } from "better-auth"
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { MIN_PASSWORD_LENGTH } from "../../lib/password.ts"
import { ac, roles } from "./access.ts"
import type { GoogleClient } from "./google.ts"
import type { OwnAction, TargetAction } from "./policy.ts"
import type { BetterAuthSession } from "./session-account.ts"

const DAY = 24 * 60 * 60

export interface AuthOptionsInput {
  readonly database: BetterAuthOptions["database"]
  readonly baseURL: string
  readonly secret: string
  // Introspects the database on every request, so the Worker passes false.
  readonly validateSchema: boolean
  // Only Production and Staging have one; see google.ts.
  readonly google?: GoogleClient
  readonly sendVerificationEmail: (mail: LinkMail) => Promise<void>
  readonly sendResetPassword: (mail: LinkMail) => Promise<void>
  // Runs after every write of an account.
  readonly grantAdmin: (user: WrittenUser) => Promise<void>
  // Throws Better Auth's APIError when the access policy refuses the action.
  readonly authorizeOwnAction: (request: {
    readonly action: OwnAction
    readonly session: BetterAuthSession | null
  }) => Promise<void>
  // Throws Better Auth's APIError when the access policy refuses the action.
  readonly authorizeAdminAction: (request: {
    readonly action: TargetAction
    readonly session: BetterAuthSession | null
    readonly target: TargetUser
  }) => Promise<void>
}

export type TargetUser = Pick<
  BetterAuthSession["user"],
  "id" | "email" | "role" | "banned"
>

interface LinkMail {
  readonly email: string
  readonly url: string
}

export interface WrittenUser {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly role?: unknown
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

// With auto sign-in on, Better Auth answers a sign-up for a taken email with
// 422, and an after-hook can't change that status. Answer it here as a
// success with no session, after hashing the password as a new sign-up
// would, so the form reveals nothing.
const hideTakenEmail = async (ctx: HookContext) => {
  const { email, password } = ctx.body ?? {}
  if (typeof email !== "string" || typeof password !== "string") return
  const taken = await ctx.context.internalAdapter.findUserByEmail(
    email.toLowerCase()
  )
  if (!taken) return
  await ctx.context.password.hash(password)
  return ctx.json({ token: null, user: null })
}

// The routes where an account acts on itself. Each asks the access policy
// first, which refuses them while impersonating, and refuses change email and
// delete to a config admin.
const OWN_ACCOUNT_ROUTES: Readonly<Partial<Record<string, OwnAction>>> = {
  "/update-user": "own.update-profile",
  "/change-password": "own.change-password",
  "/revoke-session": "own.end-sessions",
  "/revoke-sessions": "own.end-sessions",
  "/revoke-other-sessions": "own.end-sessions",
  "/change-email": "own.change-email",
  "/delete-user": "own.delete",
  "/delete-user/callback": "own.delete",
}

// The admin plugin's routes that act on one account, and the body field that
// names it: a user id, or the token of one of its sessions.
const ADMIN_ROUTES: Readonly<
  Partial<
    Record<
      string,
      { readonly action: TargetAction; readonly by: "userId" | "sessionToken" }
    >
  >
> = {
  "/admin/ban-user": { action: "admin.ban", by: "userId" },
  "/admin/unban-user": { action: "admin.unban", by: "userId" },
  "/admin/set-role": { action: "admin.set-role", by: "userId" },
  "/admin/revoke-user-sessions": { action: "admin.end-sessions", by: "userId" },
  "/admin/revoke-user-session": {
    action: "admin.end-sessions",
    by: "sessionToken",
  },
}

const targetUser = async (
  ctx: HookContext,
  by: "userId" | "sessionToken"
): Promise<TargetUser | null> => {
  const key: unknown = ctx.body?.[by]
  if (typeof key !== "string" && typeof key !== "number") return null
  const { internalAdapter } = ctx.context
  return by === "userId"
    ? internalAdapter.findUserById(String(key))
    : ((await internalAdapter.findSession(String(key)))?.user ?? null)
}

const lookup = <A>(table: Readonly<Partial<Record<string, A>>>, path: string) =>
  Object.hasOwn(table, path) ? table[path] : undefined

const before = (input: AuthOptionsInput) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/sign-up/email") return hideTakenEmail(ctx)
    const own = lookup(OWN_ACCOUNT_ROUTES, ctx.path)
    const onAccount = lookup(ADMIN_ROUTES, ctx.path)
    if (own === undefined && onAccount === undefined) return
    // Past the cookie cache, so a session ended elsewhere acts on nothing and
    // admin power always sees the current role.
    const session = await getAuthoritativeSessionFromCtx(ctx)
    if (own !== undefined)
      return input.authorizeOwnAction({ action: own, session })
    if (onAccount === undefined) return
    const target = await targetUser(ctx, onAccount.by)
    // No such account: Better Auth answers for it, and there is nothing to
    // protect.
    if (target === null) return
    await input.authorizeAdminAction({
      action: onAccount.action,
      session,
      target,
    })
  })

export function authOptions(input: AuthOptionsInput) {
  const grantAdmin = async (user: WrittenUser | null) => {
    if (user !== null) await input.grantAdmin(user)
  }
  return {
    appName: "KUMORA",
    baseURL: input.baseURL,
    trustedOrigins: [input.baseURL],
    secret: input.secret,
    database: input.database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // An unverified account signs in and holds a session; the sign-in gate
      // shows it the verify screen instead of any page.
      requireEmailVerification: false,
      autoSignIn: true,
      // Also creates the password of an account that has none (Google only).
      sendResetPassword: ({ user, url }) =>
        input.sendResetPassword({ email: user.email, url }),
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: DAY,
      sendVerificationEmail: ({ user, url }) =>
        input.sendVerificationEmail({ email: user.email, url }),
    },
    // Account linking keeps Better Auth's defaults: Google is not a trusted
    // provider and the password account must be verified, so Google on the
    // email of an unverified one redirects with "account not linked".
    socialProviders: input.google ? { google: input.google } : {},
    session: {
      expiresIn: 30 * DAY,
      updateAge: DAY,
      cookieCache: { enabled: true, maxAge: 300 },
    },
    hooks: { before: before(input) },
    // Every account write passes here, so a sign-up with a provider that
    // already verified the email (Google) is covered as well as the link.
    databaseHooks: {
      user: {
        create: { after: grantAdmin },
        update: { after: grantAdmin },
      },
    },
    advanced: { database: { validateSchema: input.validateSchema } },
    // Must stay last.
    plugins: [
      admin({
        ac,
        roles,
        defaultRole: "member",
        adminRoles: ["admin"],
        impersonationSessionDuration: 60 * 60,
      }),
      tanstackStartCookies(),
    ],
  } satisfies BetterAuthOptions
}
