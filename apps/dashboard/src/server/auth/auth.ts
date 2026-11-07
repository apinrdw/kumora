import { WorkerEnv, waitUntilLive } from "@workspace/server"
import { betterAuth } from "better-auth"
import { Context, Effect, Layer } from "effect"
import type { UnknownError } from "effect/Cause"

import { Accounts, roleOf } from "./accounts.ts"
import { AdminEmails } from "./admin-emails.ts"
import {
  grantAdmin,
  makeCallbackRunner,
  sendVerificationEmail,
} from "./callbacks.ts"
import { Mailer } from "./mailer.ts"
import { authOptions, type AuthOptionsInput } from "./options.ts"
import type { Role } from "./policy.ts"

type AuthConfig = Omit<AuthOptionsInput, "sendVerificationEmail" | "grantAdmin">

// What the gates read of a session.
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
    // An admin is viewing as this account.
    readonly impersonated: boolean
  }
}

export class Auth extends Context.Service<
  Auth,
  {
    readonly handler: (
      request: Request
    ) => Effect.Effect<Response, UnknownError>
    // `fresh` skips the 5-minute cookie cache and reads the database, which
    // also rewrites the cache cookie.
    readonly getSession: (
      headers: Headers,
      options?: { readonly fresh?: boolean }
    ) => Effect.Effect<AuthSession | null, UnknownError>
  }
>()("dashboard/server/auth/Auth") {
  // Built per request: the database and secret are request-scoped bindings.
  static readonly make = (config: AuthConfig) =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const context = yield* Effect.context<Mailer | AdminEmails | Accounts>()
        const run = makeCallbackRunner(context)
        const adminEmails = Context.get(context, AdminEmails)
        const auth = betterAuth(
          authOptions({
            ...config,
            sendVerificationEmail: ({ email, url }) =>
              run(sendVerificationEmail(email, url)),
            grantAdmin: (user) => run(grantAdmin(user)),
          })
        )
        return Auth.of({
          handler: (request) => Effect.tryPromise(() => auth.handler(request)),
          getSession: (headers, options) =>
            Effect.tryPromise(() =>
              auth.api.getSession({
                headers,
                query: { disableCookieCache: options?.fresh ?? false },
              })
            ).pipe(
              Effect.map((found) => {
                if (found === null) return null
                const { user, session } = found
                const role = roleOf(user.role)
                return {
                  user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    emailVerified: user.emailVerified,
                    role,
                    banned: user.banned === true,
                    configAdmin:
                      role === "admin" && adminEmails.includes(user.email),
                  },
                  session: { impersonated: Boolean(session.impersonatedBy) },
                }
              })
            ),
        })
      })
    )

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const env = yield* WorkerEnv
      return Auth.make({
        database: env.AUTH_DB,
        baseURL: env.AUTH_BASE_URL,
        secret: env.BETTER_AUTH_SECRET,
        // Decision: no schema check on the Worker. It would introspect D1 on
        // every request, since Auth is built per request; the migration drift
        // check in CI and the handler test seam cover the schema.
        validateSchema: false,
      }).pipe(Layer.provideMerge(Accounts.make(env.AUTH_DB)))
    })
  ).pipe(
    Layer.provideMerge(AdminEmails.layer),
    Layer.provide(Mailer.layer),
    Layer.provide(waitUntilLive)
  )
}
