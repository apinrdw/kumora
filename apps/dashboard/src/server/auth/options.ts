// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or
// `@workspace/server`, whose bridge reaches cloudflare:workers.
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api"
import { deleteSessionCookie } from "better-auth/cookies"
import { verifyJWT } from "better-auth/crypto"
import { admin } from "better-auth/plugins/admin"
import { captcha } from "better-auth/plugins/captcha"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { Effect, Predicate } from "effect"

import { LINK_HOURS } from "../../lib/link-lifetime.ts"
import { MIN_PASSWORD_LENGTH, resetPasswordPage } from "../../lib/password.ts"
import type { FileRoutesByFullPath } from "../../routeTree.gen.ts"
import {
  AccountId,
  SessionId,
  type HeldSessions,
} from "../market-live/routes.ts"
import { ac, roles } from "./access.ts"
import type { GoogleClient } from "./google.ts"
import type { OwnAction, TargetAction } from "./policy.ts"
import type { BetterAuthSession } from "./session-account.ts"

const HOUR = 60 * 60
const DAY = 24 * HOUR

const RESET_TOKEN_SECONDS = LINK_HOURS.reset * HOUR

// An admin views as a member for at most this long (apinrdw/kumora#80).
const IMPERSONATION_SESSION = HOUR

const impersonatedBy = (session: object): Effect.Effect<unknown> =>
  Effect.succeed(
    "impersonatedBy" in session ? session.impersonatedBy : undefined
  )

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
  // Decision: the Worker passes none and hashes with Better Auth's scrypt.
  // The test seam passes a fast stand-in, since scrypt costs about 57 ms per
  // sign-up (apinrdw/kumora#171); handler.test.ts keeps one test on scrypt.
  readonly password?: NonNullable<
    BetterAuthOptions["emailAndPassword"]
  >["password"]
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
  // Throws Better Auth's APIError when the access policy refuses the action,
  // and when `target` is null: the userId names no account.
  // Runs after every session row is deleted: closes the account's live Market
  // Live pages on any session it no longer holds.
  readonly endLiveSessions: (held: HeldSessions) => Promise<void>
  readonly authorizeAdminAction: (request: {
    readonly action: TargetAction
    readonly session: BetterAuthSession | null
    readonly target: TargetUser | null
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

// Decision: Better Auth's hooks must return a Promise, so each runs its Effect
// here with a bare runPromise and no services, which rejects with the APIError
// or a dying call's error unchanged, as Better Auth expects of a throw. Not
// makeCallbackRunner (callbacks.ts): it needs @workspace/server, which the
// migration script can't load. See apinrdw/kumora#159.
const runHook = <A>(effect: Effect.Effect<A, APIError>): Promise<A> =>
  Effect.runPromise(effect)

// Minted as Better Auth's /request-password-reset mints one, so its
// /reset-password/:token and /reset-password routes spend it, and setting the
// password ends every session (revokeSessionsOnPasswordReset).
const setPasswordLink = Effect.fnUntraced(function* (
  ctx: HookContext,
  userId: string,
  redirect: unknown
) {
  const token = crypto.randomUUID().replaceAll("-", "")
  yield* Effect.promise(() =>
    ctx.context.internalAdapter.createVerificationValue({
      value: userId,
      identifier: `reset-password:${token}`,
      expiresAt: new Date(Date.now() + RESET_TOKEN_SECONDS * 1000),
    })
  )
  const page = yield* resetPasswordPage(
    typeof redirect === "string" ? redirect : "/"
  )
  return `${ctx.context.baseURL}/reset-password/${token}?callbackURL=${encodeURIComponent(page)}`
})

// Leaves the account with no password and no session, still unverified. Both
// writes converge, so a sign-up retried after a failure between them ends in
// the same state. Not Better Auth's revokeUnprovenAccountAccess, which also
// marks the email verified: nothing is proven yet.
const voidAccess = Effect.fnUntraced(function* (
  ctx: HookContext,
  userId: string
) {
  const { internalAdapter } = ctx.context
  // A browser signed in as this account keeps the session in its cookie
  // cache for 5 minutes past the delete, and Resend would read it there:
  // expire its session cookies, as sign-out does.
  const signedIn = yield* Effect.promise(() => getSessionFromCtx(ctx))
  if (signedIn?.user.id === userId) deleteSessionCookie(ctx)
  yield* Effect.promise(() => internalAdapter.deleteUserSessions(userId))
  const credential = yield* Effect.promise(() =>
    internalAdapter.findCredentialAccount(userId)
  )
  if (credential)
    yield* Effect.promise(() =>
      internalAdapter.updateAccount(credential.id, { password: null })
    )
})

// With auto sign-in on, Better Auth refuses a sign-up for a taken email with
// 422, after checking the input exactly as it does for a new email. Replace
// that refusal with a success and no session, after hashing the password as a
// new sign-up would, so the form reveals nothing. A Response, not ctx.json:
// the 422 would stay on a plain body. A verified account's address gets no
// mail and loses nothing. The set-password mail is sent as Better Auth's
// sign-up mail is, so over the mail cap the answer stays the same.
// Decision: an unverified account is nobody's yet, so this sign-up voids its
// password and sessions now, not when the link is opened, and mails a
// set-password link; an earlier verify link then leaves the squatter nothing.
// Anyone can void a never-verified password this way, bounded by the sign-up
// rate limit and mail cap. See apinrdw/kumora#80, "Signing in".
const hideTakenEmail = Effect.fnUntraced(function* (
  ctx: HookContext,
  input: AuthOptionsInput
) {
  const { email, password, callbackURL } = ctx.body ?? {}
  const refused = ctx.context.returned
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !isAPIError(refused) ||
    refused.statusCode !== 422
  )
    return
  const taken = yield* Effect.promise(() =>
    ctx.context.internalAdapter.findUserByEmail(email.toLowerCase())
  )
  if (!taken) return
  yield* Effect.promise(() => ctx.context.password.hash(password))
  if (!taken.user.emailVerified) {
    yield* voidAccess(ctx, taken.user.id)
    const url = yield* setPasswordLink(ctx, taken.user.id, callbackURL)
    const sent = ctx.context.runInBackgroundOrAwait(
      input.sendSetPassword({ email: taken.user.email, url })
    )
    if (Predicate.isPromiseLike(sent)) yield* Effect.promise(() => sent)
  }
  return Response.json({ token: null, user: null })
})

// Better Auth takes at least this long to answer a signed-out resend, so the
// reply's timing says nothing about the address.
const RESEND_MINIMUM_MS = 500

// The inbox screen's Resend, with no session: the browser that signed up on
// a taken email holds none, so it gets the set-password link again, never a
// verify link that would verify the first password. A session, the new
// account's own, is left to Better Auth and keeps its verify link.
const resendSetPassword = Effect.fnUntraced(function* (
  ctx: HookContext,
  input: AuthOptionsInput
) {
  const { email, callbackURL } = ctx.body ?? {}
  if (typeof email !== "string") return
  if ((yield* Effect.promise(() => getSessionFromCtx(ctx))) !== null) return
  const found = yield* Effect.promise(() =>
    ctx.context.internalAdapter.findUserByEmail(email.toLowerCase())
  )
  if (!found || found.user.emailVerified) return
  const start = Date.now()
  const url = yield* setPasswordLink(ctx, found.user.id, callbackURL)
  yield* Effect.promise(() =>
    input.sendSetPassword({ email: found.user.email, url })
  )
  const remaining = RESEND_MINIMUM_MS - (Date.now() - start)
  if (remaining > 0) yield* Effect.sleep(remaining)
  return ctx.json({ status: true })
})

// The routes where an account acts on itself. Each asks the access policy
// first, which refuses them while impersonating, and refuses change email and
// delete to a config admin.
const OWN_ACCOUNT_ROUTES: Readonly<Partial<Record<string, OwnAction>>> = {
  "/update-user": "own.update-details",
  "/change-password": "own.change-password",
  "/revoke-session": "own.end-sessions",
  "/revoke-other-sessions": "own.end-sessions",
  "/change-email": "own.change-email",
  "/delete-user": "own.delete",
  "/delete-user/callback": "own.delete",
}

// The admin plugin's routes that act on one account, named by the userId in
// the body. stop-impersonating is not here: it acts only on an impersonation
// session, which Better Auth checks itself.
const ADMIN_ROUTES: Readonly<Partial<Record<string, TargetAction>>> = {
  "/admin/ban-user": "admin.ban",
  "/admin/unban-user": "admin.unban",
  "/admin/impersonate-user": "admin.impersonate",
  "/admin/set-role": "admin.set-role",
  "/admin/revoke-user-sessions": "admin.end-sessions",
}

// Every route Better Auth mounts that the dashboard offers nobody, so no
// policy rule covers it: Better Auth answers 404 to every caller. The set is
// held against the router's own endpoints in tests/server/auth/routes.test.ts.
// Each would otherwise reach an account, or an admin viewing as a member,
// past the policy: the sign-in method routes unlink or link the member's
// Google or read its tokens, and the spec has no unlinking (apinrdw/kumora#80,
// "User settings"); /verify-password checks the member's password, 100 tries
// per 10 seconds, though Better Auth marks it server-scoped; the admin reads
// list what the admin pages read through the policy already.
const DISABLED_ROUTES = [
  "/admin/create-user",
  "/admin/update-user",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
  "/admin/list-users",
  "/admin/get-user",
  "/admin/list-user-sessions",
  "/admin/revoke-user-session",
  "/unlink-account",
  "/link-social",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
  "/list-accounts",
  "/list-sessions",
  "/revoke-sessions",
  "/update-session",
  "/verify-password",
  "/ok",
]

const badRequest = (message: string) =>
  Effect.fail(new APIError("BAD_REQUEST", { message }))

// The account an admin route acts on. Better Auth's admin schemas take the
// userId through String(), so an array of one id would name that account
// once past this hook: every shape but a non-empty string is refused here.
const targetUser = Effect.fnUntraced(function* (
  ctx: HookContext
): Effect.fn.Return<TargetUser | null, APIError> {
  const userId: unknown = ctx.body?.userId
  if (typeof userId !== "string" || userId === "")
    return yield* badRequest("userId must be a non-empty string")
  return yield* Effect.promise(() =>
    ctx.context.internalAdapter.findUserById(userId)
  )
})

const lookup = <A>(
  table: Readonly<Partial<Record<string, A>>>,
  path: string
): Effect.Effect<A | undefined> =>
  Effect.succeed(Object.hasOwn(table, path) ? table[path] : undefined)

// The account a change-email link's token is bound to, or null for any other
// link. A repeated query key parses as an array and is refused; an invalid or
// expired token is left to Better Auth, which answers with the error code the
// page shows.
const emailChangeTarget = Effect.fnUntraced(function* (
  ctx: HookContext
): Effect.fn.Return<TargetUser | null, APIError> {
  const token: unknown = ctx.query?.token
  if (typeof token !== "string")
    return yield* badRequest("token must be a string")
  const payload = yield* Effect.promise(() =>
    verifyJWT(token, ctx.context.secret)
  )
  if (
    payload === null ||
    typeof payload.updateTo !== "string" ||
    typeof payload.userId !== "string"
  )
    return null
  const { userId } = payload
  return yield* Effect.promise(() =>
    ctx.context.internalAdapter.findUserById(userId)
  )
})

// /verify-email finishes a change of email, from any browser, signed in or
// not. Only the request asked the policy, so a link sent before the account
// became a config admin would still move its email: ask again now.
const authorizeEmailChangeLink = Effect.fnUntraced(function* (
  ctx: HookContext,
  input: AuthOptionsInput
) {
  const user = yield* emailChangeTarget(ctx)
  if (user === null) return
  const session = yield* Effect.promise(() =>
    getAuthoritativeSessionFromCtx(ctx)
  )
  yield* Effect.promise(() => input.authorizeEmailChange({ user, session }))
})

const beforeHook = Effect.fnUntraced(function* (
  ctx: HookContext,
  input: AuthOptionsInput
) {
  if (ctx.path === "/send-verification-email")
    return yield* resendSetPassword(ctx, input)
  if (ctx.path === "/verify-email")
    return yield* authorizeEmailChangeLink(ctx, input)
  const own = yield* lookup(OWN_ACCOUNT_ROUTES, ctx.path)
  const onAccount = yield* lookup(ADMIN_ROUTES, ctx.path)
  if (own === undefined && onAccount === undefined) return
  // Past the cookie cache, so a session ended elsewhere acts on nothing and
  // admin power always sees the current role.
  const session = yield* Effect.promise(() =>
    getAuthoritativeSessionFromCtx(ctx)
  )
  if (own !== undefined)
    return yield* Effect.promise(() =>
      input.authorizeOwnAction({ action: own, session })
    )
  if (onAccount === undefined) return
  const target = yield* targetUser(ctx)
  yield* Effect.promise(() =>
    input.authorizeAdminAction({ action: onAccount, session, target })
  )
})

// Decision: `before` and `after` stay plain functions, not Effects: they build
// Better Auth's hook middleware for authOptions, which is plain (see its
// Decision) and so can't yield them.
const before = (input: AuthOptionsInput) =>
  createAuthMiddleware((ctx) => runHook(beforeHook(ctx, input)))

// Decision: live pages close from the session table's delete hook, not a table
// of routes: every route that ends a session deletes its row through it, after
// its transaction. It sends the sessions still held, read after the delete, so
// a failed route ends nothing. A session that expires unread deletes no row, so
// gate.ts and trading-day.ts close that one. See apinrdw/kumora#157.
const endLiveSessions = Effect.fnUntraced(function* (
  input: AuthOptionsInput,
  ended: { readonly userId: string },
  // Null outside an endpoint, where Better Auth deletes nothing.
  ctx: Pick<HookContext, "context"> | null
) {
  if (ctx === null) return
  const sessions = yield* Effect.promise(() =>
    ctx.context.internalAdapter.listSessions(ended.userId, {
      onlyActiveSessions: true,
    })
  )
  yield* Effect.promise(() =>
    input.endLiveSessions({
      userId: AccountId.make(ended.userId),
      sessionIds: sessions.map((session) => SessionId.make(session.id)),
    })
  )
})

const after = (input: AuthOptionsInput) =>
  createAuthMiddleware((ctx) =>
    runHook(
      ctx.path === "/sign-up/email"
        ? hideTakenEmail(ctx, input)
        : Effect.succeed(undefined)
    )
  )

// Every account write, and every new session, may grant admin.
const grantAdminOf = Effect.fnUntraced(function* (
  input: AuthOptionsInput,
  user: WrittenUser | null
) {
  if (user !== null) yield* Effect.promise(() => input.grantAdmin(user))
})

const grantAdminOfSession = Effect.fnUntraced(function* (
  input: AuthOptionsInput,
  userId: string,
  ctx: Pick<HookContext, "context"> | null | undefined
) {
  if (!ctx) return
  const user = yield* Effect.promise(() =>
    ctx.context.internalAdapter.findUserById(userId)
  )
  yield* grantAdminOf(input, user)
})

// get-session renews a session within updateAge of its renewal at the full
// expiresIn, and an impersonation session, made an hour from its end, always
// is. Only the dont_remember cookie keeps it off that path, so the hour is
// held here, where the browser's cookies can't reach.
const capImpersonationExpiry = Effect.fnUntraced(function* (
  data: { readonly expiresAt?: Date | undefined },
  ctx: Pick<HookContext, "context"> | null | undefined
) {
  const current = ctx?.context.session?.session
  if (!data.expiresAt || !current || !(yield* impersonatedBy(current)))
    return undefined
  const deadline = new Date(
    current.createdAt.getTime() + IMPERSONATION_SESSION * 1000
  )
  return {
    data: {
      expiresAt: data.expiresAt < deadline ? data.expiresAt : deadline,
    },
  }
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

// Decision: authOptions stays a plain function, not an Effect: Better Auth,
// the test seam and the migration script take the options object as is.
// CODING_STANDARDS.md lists such config builders among the exceptions.
export function authOptions(input: AuthOptionsInput) {
  const grantAdmin = (user: WrittenUser | null) =>
    runHook(grantAdminOf(input, user))
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
      password: input.password,
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
          after: ({ userId }, ctx) =>
            runHook(grantAdminOfSession(input, userId, ctx)),
        },
        delete: {
          after: (session, ctx) =>
            runHook(endLiveSessions(input, session, ctx)),
        },
        update: {
          before: (data, ctx) => runHook(capImpersonationExpiry(data, ctx)),
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
