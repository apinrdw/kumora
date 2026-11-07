// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api"
import { verifyJWT } from "better-auth/crypto"
import { admin } from "better-auth/plugins/admin"
import { captcha } from "better-auth/plugins/captcha"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { LINK_HOURS } from "../../lib/link-lifetime.ts"
import { MIN_PASSWORD_LENGTH, resetPasswordPage } from "../../lib/password.ts"
import type { FileRoutesByFullPath } from "../../routeTree.gen.ts"
import { ac, roles } from "./access.ts"
import type { GoogleClient } from "./google.ts"
import type { OwnAction, TargetAction } from "./policy.ts"
import type { BetterAuthSession } from "./session-account.ts"

const HOUR = 60 * 60
const DAY = 24 * HOUR

const RESET_TOKEN_SECONDS = LINK_HOURS.reset * HOUR

// An admin views as a member for at most this long (apinrdw/kumora#80).
const IMPERSONATION_SESSION = HOUR

const impersonatedBy = (session: object): unknown =>
  "impersonatedBy" in session ? session.impersonatedBy : undefined

// The page the delete link opens: src/routes/_app/delete-account.tsx. e2e
// finds the link by it in apps/e2e/support/mail.ts.
const DELETE_ACCOUNT_PATH =
  "/delete-account" satisfies keyof FileRoutesByFullPath

// Cloudflare sets it to the client's address on every request. e2e sends
// its own per browser context: apps/e2e/support/test.ts.
export const CLIENT_IP_HEADER = "cf-connecting-ip"

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
  // To an unverified account's address when someone signs up on it again, or
  // asks for its verification mail with no session: a reset link that hands
  // the account to whoever reads the inbox.
  readonly sendSetPassword: (mail: LinkMail) => Promise<void>
  // Runs after a password is set through a reset link: the inbox is proven.
  readonly verifyByPasswordReset: (user: WrittenUser) => Promise<void>
  readonly turnstileSecretKey: string
  // Change email, step one: the old address confirms the move.
  readonly sendChangeEmailConfirmation: (
    mail: LinkMail & { readonly newEmail: string }
  ) => Promise<void>
  // Change email, step two: the new address verifies.
  readonly sendNewEmailVerification: (mail: LinkMail) => Promise<void>
  readonly sendDeleteAccountLink: (mail: LinkMail) => Promise<void>
  // Runs after every write of an account.
  readonly grantAdmin: (user: WrittenUser) => Promise<void>
  // Throws Better Auth's APIError when the access policy refuses the action.
  readonly authorizeOwnAction: (request: {
    readonly action: OwnAction
    readonly session: BetterAuthSession | null
  }) => Promise<void>
  // Throws Better Auth's APIError when the access policy refuses `user`, the
  // account a change-email link is bound to, its change of email now.
  readonly authorizeEmailChange: (request: {
    readonly user: TargetUser
    readonly session: BetterAuthSession | null
  }) => Promise<void>
  // Throws Better Auth's APIError when the access policy refuses to list
  // accounts.
  readonly authorizeListAccounts: (request: {
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
  "id" | "email" | "emailVerified" | "role" | "banned"
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

// Minted as Better Auth's /request-password-reset mints one, so its
// /reset-password/:token and /reset-password routes spend it, and setting the
// password ends every session (revokeSessionsOnPasswordReset).
const setPasswordLink = async (
  ctx: HookContext,
  userId: string,
  redirect: unknown
) => {
  const token = crypto.randomUUID().replaceAll("-", "")
  await ctx.context.internalAdapter.createVerificationValue({
    value: userId,
    identifier: `reset-password:${token}`,
    expiresAt: new Date(Date.now() + RESET_TOKEN_SECONDS * 1000),
  })
  const page = resetPasswordPage(typeof redirect === "string" ? redirect : "/")
  return `${ctx.context.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(page)}`
}

// Leaves the account with no password and no session, still unverified. Both
// writes converge, so a sign-up retried after a failure between them ends in
// the same state. Not Better Auth's revokeUnprovenAccountAccess, which also
// marks the email verified: nothing is proven yet.
const voidAccess = async (ctx: HookContext, userId: string) => {
  const { internalAdapter } = ctx.context
  await internalAdapter.deleteUserSessions(userId)
  const credential = await internalAdapter.findCredentialAccount(userId)
  if (credential)
    await internalAdapter.updateAccount(credential.id, { password: null })
}

// With auto sign-in on, Better Auth refuses a sign-up for a taken email with
// 422, after checking the input exactly as it does for a new email. Replace
// that refusal with a success and no session, after hashing the password as a
// new sign-up would, so the form reveals nothing. A Response, not ctx.json:
// the 422 would stay on a plain body.
// Decision: an unverified account is nobody's yet, so this sign-up voids its
// password and sessions at once and mails its address a set-password link, so
// whoever reads the inbox takes the account. Voiding now, not when the link
// is opened, means a plain verify link mailed earlier (the first sign-up's
// own, or its Resend) verifies an account with no password and no session,
// and the squatter keeps nothing. The accepted cost is that anyone can void a
// never-verified account's password by signing up on its email; the sign-up
// rate limit and the per-address mail cap bound it. A verified account's
// address gets no mail and loses nothing. See apinrdw/kumora#80, "Signing
// in". The send runs as Better Auth's sign-up mail does, so over the mail cap
// the answer stays the same.
const hideTakenEmail = async (ctx: HookContext, input: AuthOptionsInput) => {
  const { email, password, callbackURL } = ctx.body ?? {}
  const refused = ctx.context.returned
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !isAPIError(refused) ||
    refused.statusCode !== 422
  )
    return
  const taken = await ctx.context.internalAdapter.findUserByEmail(
    email.toLowerCase()
  )
  if (!taken) return
  await ctx.context.password.hash(password)
  if (!taken.user.emailVerified) {
    await voidAccess(ctx, taken.user.id)
    await ctx.context.runInBackgroundOrAwait(
      input.sendSetPassword({
        email: taken.user.email,
        url: await setPasswordLink(ctx, taken.user.id, callbackURL),
      })
    )
  }
  return Response.json({ token: null, user: null })
}

// Better Auth takes at least this long to answer a signed-out resend, so the
// reply's timing says nothing about the address.
const RESEND_MINIMUM_MS = 500

// The inbox screen's Resend, with no session: the browser that signed up on
// a taken email holds none, so it gets the set-password link again, never a
// verify link that would verify the first password. A session, the new
// account's own, is left to Better Auth and keeps its verify link.
const resendSetPassword = async (ctx: HookContext, input: AuthOptionsInput) => {
  const { email, callbackURL } = ctx.body ?? {}
  if (typeof email !== "string" || (await getSessionFromCtx(ctx)) !== null)
    return
  const found = await ctx.context.internalAdapter.findUserByEmail(
    email.toLowerCase()
  )
  if (!found || found.user.emailVerified) return
  const start = Date.now()
  await input.sendSetPassword({
    email: found.user.email,
    url: await setPasswordLink(ctx, found.user.id, callbackURL),
  })
  const remaining = RESEND_MINIMUM_MS - (Date.now() - start)
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining))
  return ctx.json({ status: true })
}

// The routes where an account acts on itself. Each asks the access policy
// first, which refuses them while impersonating, and refuses change email and
// delete to a config admin.
const OWN_ACCOUNT_ROUTES: Readonly<Partial<Record<string, OwnAction>>> = {
  "/update-user": "own.update-details",
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
  "/admin/impersonate-user": { action: "admin.impersonate", by: "userId" },
  "/admin/set-role": { action: "admin.set-role", by: "userId" },
  "/admin/revoke-user-sessions": { action: "admin.end-sessions", by: "userId" },
  "/admin/revoke-user-session": {
    action: "admin.end-sessions",
    by: "sessionToken",
  },
}

// The admin plugin's routes that read accounts, as admin.list-accounts.
// stop-impersonating is not here: it acts only on an impersonation session,
// which Better Auth checks itself.
const ADMIN_READ_ROUTES: ReadonlySet<string> = new Set([
  "/admin/list-users",
  "/admin/get-user",
  "/admin/list-user-sessions",
])

// The routes the dashboard offers nobody, so no policy rule covers them:
// Better Auth answers 404 to every caller. The sign-in method routes would
// otherwise let an admin viewing as a member unlink or link the member's
// Google, or read its tokens; the spec has no unlinking (apinrdw/kumora#80,
// "User settings").
const DISABLED_ROUTES = [
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
  "/unlink-account",
  "/link-social",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
  "/update-session",
]

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

// The account a change-email link's token is bound to, or null for any other
// link. Better Auth checks the token itself; an invalid one is left to it.
const emailChangeTarget = async (
  ctx: HookContext
): Promise<TargetUser | null> => {
  const token: unknown = ctx.query?.token
  if (typeof token !== "string") return null
  const payload = await verifyJWT(token, ctx.context.secret)
  if (
    payload === null ||
    typeof payload.updateTo !== "string" ||
    typeof payload.userId !== "string"
  )
    return null
  return ctx.context.internalAdapter.findUserById(payload.userId)
}

// /verify-email finishes a change of email, from any browser, signed in or
// not. Only the request asked the policy, so a link sent before the account
// became a config admin would still move its email: ask again now.
const authorizeEmailChangeLink = async (
  ctx: HookContext,
  input: AuthOptionsInput
) => {
  const user = await emailChangeTarget(ctx)
  if (user === null) return
  await input.authorizeEmailChange({
    user,
    session: await getAuthoritativeSessionFromCtx(ctx),
  })
}

const before = (input: AuthOptionsInput) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/send-verification-email")
      return resendSetPassword(ctx, input)
    if (ctx.path === "/verify-email")
      return authorizeEmailChangeLink(ctx, input)
    const own = lookup(OWN_ACCOUNT_ROUTES, ctx.path)
    const onAccount = lookup(ADMIN_ROUTES, ctx.path)
    const read = ADMIN_READ_ROUTES.has(ctx.path)
    if (own === undefined && onAccount === undefined && !read) return
    // Past the cookie cache, so a session ended elsewhere acts on nothing and
    // admin power always sees the current role.
    const session = await getAuthoritativeSessionFromCtx(ctx)
    if (own !== undefined)
      return input.authorizeOwnAction({ action: own, session })
    if (read) return input.authorizeListAccounts({ session })
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

const after = (input: AuthOptionsInput) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/sign-up/email") return hideTakenEmail(ctx, input)
  })

// The per-address mail cap's table (mail-cap.ts). A plugin schema, so the
// migration script generates it and Better Auth's adapter reaches it on D1 and
// SQLite alike.
export const MAIL_CAP_MODEL = "mailCap"

const mailCapTable = {
  id: "mail-cap",
  schema: {
    [MAIL_CAP_MODEL]: {
      fields: {
        address: { type: "string", unique: true, required: true },
        count: { type: "number", required: true },
        windowStart: { type: "number", bigint: true, required: true },
      },
    },
  },
} satisfies BetterAuthPlugin

export function authOptions(input: AuthOptionsInput) {
  const grantAdmin = async (user: WrittenUser | null) => {
    if (user !== null) await input.grantAdmin(user)
  }
  return {
    appName: "KUMORA",
    baseURL: input.baseURL,
    trustedOrigins: [input.baseURL],
    disabledPaths: DISABLED_ROUTES,
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
      resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // A password set from a mailed link proves the inbox, so the account
      // is verified, whichever link it was (setPasswordLink or a reset).
      onPasswordReset: ({ user }) => input.verifyByPasswordReset(user),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: LINK_HOURS.verify * HOUR,
      // A verified account is mailed a verification link only to move to a
      // new email: Better Auth hands over the account with that new email.
      sendVerificationEmail: ({ user, url }) =>
        user.emailVerified
          ? input.sendNewEmailVerification({ email: user.email, url })
          : input.sendVerificationEmail({ email: user.email, url }),
    },
    user: {
      // The old address confirms first, so a stolen session can't move the
      // account to another inbox; the email changes once the new one verifies.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: ({ user, newEmail, url }) =>
          input.sendChangeEmailConfirmation({
            email: user.email,
            newEmail,
            url,
          }),
      },
      // Only by an emailed link, so a Google-only account can delete too and a
      // stolen session can't. The link opens /delete-account, which asks
      // before it spends the token and sends a signed-out visitor to sign in.
      deleteUser: {
        enabled: true,
        deleteTokenExpiresIn: LINK_HOURS.delete * HOUR,
        sendDeleteAccountVerification: ({ user, token }) =>
          input.sendDeleteAccountLink({
            email: user.email,
            url: `${input.baseURL}${DELETE_ACCOUNT_PATH}?token=${token}`,
          }),
      },
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
    hooks: { before: before(input), after: after(input) },
    // Every account write passes here, so a sign-up with a sign-in method
    // that already verified the email (Google) is covered as well as the link.
    // Every sign-in too, for an email put on ADMIN_EMAILS after it verified.
    databaseHooks: {
      user: {
        create: { after: grantAdmin },
        update: { after: grantAdmin },
      },
      session: {
        create: {
          after: async ({ userId }, ctx) =>
            grantAdmin(
              (await ctx?.context.internalAdapter.findUserById(userId)) ?? null
            ),
        },
        // get-session renews a session within updateAge of its renewal at the
        // full expiresIn, and an impersonation session, made an hour from its
        // end, always is. Only the dont_remember cookie keeps it off that
        // path, so the hour is held here, where the browser's cookies can't
        // reach.
        update: {
          before: async (data, ctx) => {
            const current = ctx?.context.session?.session
            if (!data.expiresAt || !current || !impersonatedBy(current)) return
            const deadline = new Date(
              current.createdAt.getTime() + IMPERSONATION_SESSION * 1000
            )
            return {
              data: {
                expiresAt:
                  data.expiresAt < deadline ? data.expiresAt : deadline,
              },
            }
          },
        },
      },
    },
    // Per IP, counted in D1 so every isolate shares the count. Set explicitly:
    // Better Auth turns the limiter on only when NODE_ENV is production. Paths
    // not named here keep Better Auth's defaults, which include 3 per 10 s on
    // change-password and change-email.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 10,
      max: 100,
      customRules: {
        "/sign-in/*": { window: 60, max: 10 },
        "/sign-up/*": { window: HOUR, max: 5 },
        "/send-verification-email": { window: HOUR, max: 3 },
        "/request-password-reset": { window: HOUR, max: 3 },
      },
    },
    advanced: {
      database: { validateSchema: input.validateSchema },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [
      admin({
        ac,
        roles,
        defaultRole: "member",
        adminRoles: ["admin"],
        impersonationSessionDuration: IMPERSONATION_SESSION,
      }),
      // Only the two forms that send mail; sign-in never shows a challenge.
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: input.turnstileSecretKey,
        endpoints: ["/sign-up/email", "/request-password-reset"],
      }),
      mailCapTable,
      // Must stay last.
      tanstackStartCookies(),
    ],
  } satisfies BetterAuthOptions
}
