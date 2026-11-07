import { WorkerEnv } from "@workspace/server"
import { betterAuth } from "better-auth"
import { Context, Effect, Layer } from "effect"
import type { UnknownError } from "effect/Cause"

import { makeCallbackRunner, sendVerificationEmail } from "./callbacks.ts"
import { Mailer } from "./mailer.ts"
import { authOptions, type AuthOptionsInput } from "./options.ts"

type AuthConfig = Omit<AuthOptionsInput, "sendVerificationEmail">

// What the gates read of a session. Later plugins widen it (role, banned).
export interface AuthSession {
  readonly user: {
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
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
        const run = makeCallbackRunner(yield* Effect.context<Mailer>())
        const auth = betterAuth(
          authOptions({
            ...config,
            sendVerificationEmail: ({ email, url }) =>
              run(sendVerificationEmail(email, url)),
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
      })
    })
  ).pipe(Layer.provide(Mailer.layer))
}
