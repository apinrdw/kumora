// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { captcha } from "better-auth/plugins/captcha"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { MIN_PASSWORD_LENGTH } from "../../lib/password.ts"

const HOUR = 60 * 60
const DAY = 24 * HOUR

export interface AuthOptionsInput {
  readonly database: BetterAuthOptions["database"]
  readonly baseURL: string
  readonly secret: string
  // Introspects the database on every request, so the Worker passes false.
  readonly validateSchema: boolean
  readonly sendVerificationEmail: (mail: LinkMail) => Promise<void>
  readonly sendResetPassword: (mail: LinkMail) => Promise<void>
  readonly turnstileSecretKey: string
}

interface LinkMail {
  readonly email: string
  readonly url: string
}

// With auto sign-in on, Better Auth answers a sign-up for a taken email with
// 422, and an after-hook can't change that status. Answer it here as a
// success with no session, after hashing the password as a new sign-up
// would, so the form reveals nothing.
const hideTakenEmail = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-up/email") return
  const { email, password } = ctx.body ?? {}
  if (typeof email !== "string" || typeof password !== "string") return
  const taken = await ctx.context.internalAdapter.findUserByEmail(
    email.toLowerCase()
  )
  if (!taken) return
  await ctx.context.password.hash(password)
  return ctx.json({ token: null, user: null })
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
    session: {
      expiresIn: 30 * DAY,
      updateAge: DAY,
      cookieCache: { enabled: true, maxAge: 300 },
    },
    hooks: { before: hideTakenEmail },
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
