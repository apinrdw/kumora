// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { admin } from "better-auth/plugins/admin"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { MIN_PASSWORD_LENGTH } from "../../lib/password.ts"
import { ac, roles } from "./access.ts"

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
  // Runs after every write of an account.
  readonly grantAdmin: (user: WrittenUser) => Promise<void>
}

export interface WrittenUser {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly role?: unknown
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
