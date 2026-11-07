// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { captcha } from "better-auth/plugins/captcha"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { MIN_PASSWORD_LENGTH } from "../../lib/password.ts"
import { ac, roles } from "./access.ts"
import type { GoogleClient } from "./google.ts"
import type { OwnAction } from "./policy.ts"
import type { BetterAuthSession } from "./session-account.ts"

const HOUR = 60 * 60
const DAY = 24 * HOUR

// The page the delete link opens: src/routes/_app/delete-account.tsx.
const DELETE_ACCOUNT_PATH = "/delete-account"

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
}

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

const before = (input: AuthOptionsInput) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/sign-up/email") return hideTakenEmail(ctx)
    const action = Object.hasOwn(OWN_ACCOUNT_ROUTES, ctx.path)
      ? OWN_ACCOUNT_ROUTES[ctx.path]
      : undefined
    if (action === undefined) return
    // Past the cookie cache, so a session ended elsewhere acts on nothing.
    const session = await getAuthoritativeSessionFromCtx(ctx)
    await input.authorizeOwnAction({ action, session })
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
        deleteTokenExpiresIn: 60 * 60,
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
    hooks: { before: before(input) },
    // Every account write passes here, so a sign-up with a provider that
    // already verified the email (Google) is covered as well as the link.
    databaseHooks: {
      user: {
        create: { after: grantAdmin },
        update: { after: grantAdmin },
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
      // Cloudflare sets it to the client's address on every request.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      admin({
        ac,
        roles,
        defaultRole: "member",
        adminRoles: ["admin"],
        impersonationSessionDuration: 60 * 60,
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
