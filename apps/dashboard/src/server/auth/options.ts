// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { tanstackStartCookies } from "better-auth/tanstack-start"

const DAY = 24 * 60 * 60

export interface AuthOptionsInput {
  readonly database: BetterAuthOptions["database"]
  readonly baseURL: string
  readonly secret: string
  // Introspects the database on every request, so the Worker passes false.
  readonly validateSchema: boolean
  readonly sendVerificationEmail: (mail: {
    readonly email: string
    readonly url: string
  }) => Promise<void>
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

export function authOptions(input: AuthOptionsInput) {
  return {
    appName: "KUMORA",
    baseURL: input.baseURL,
    trustedOrigins: [input.baseURL],
    secret: input.secret,
    database: input.database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // An unverified account signs in and holds a session; the sign-in gate
      // shows it the verify screen instead of any page.
      requireEmailVerification: false,
      autoSignIn: true,
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
    advanced: { database: { validateSchema: input.validateSchema } },
    // Must stay last.
    plugins: [tanstackStartCookies()],
  } satisfies BetterAuthOptions
}
