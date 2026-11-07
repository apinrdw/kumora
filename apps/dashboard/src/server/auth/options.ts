// The Better Auth config, shared by the Worker (auth.ts), the handler test seam
// and the migration script (scripts/auth-migrations.ts). The script runs under
// plain Node, so this module imports only packages, never `@/` paths or Effect.
import type { BetterAuthOptions } from "better-auth"
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api"
import { tanstackStartCookies } from "better-auth/tanstack-start"

import { MIN_PASSWORD_LENGTH } from "../../lib/password.ts"
import type { OwnAction } from "./policy.ts"
import type { AuthSession } from "./session-account.ts"

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
  // Throws Better Auth's APIError when the access policy refuses the action.
  readonly authorizeOwnAction: (request: {
    readonly action: OwnAction
    readonly session: AuthSession | null
  }) => Promise<void>
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
    hooks: { before: before(input) },
    advanced: { database: { validateSchema: input.validateSchema } },
    // Must stay last.
    plugins: [tanstackStartCookies()],
  } satisfies BetterAuthOptions
}
