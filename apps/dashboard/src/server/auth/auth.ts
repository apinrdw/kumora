import { WorkerEnv, waitUntilLive } from "@workspace/server"
import { betterAuth, getCurrentAdapter, type Session } from "better-auth"
import { Context, Effect, Layer } from "effect"
import type { UnknownError } from "effect/Cause"

import { Accounts } from "./accounts.ts"
import { AdminEmails } from "./admin-emails.ts"
import {
  authorizeOwnAction,
  grantAdmin,
  makeCallbackRunner,
  sendChangeEmailConfirmation,
  sendDeleteAccountLink,
  sendNewEmailVerification,
  sendResetPassword,
  sendVerificationEmail,
  type CallbackRunner,
} from "./callbacks.ts"
import { googleClient } from "./google.ts"
import { MailCap } from "./mail-cap.ts"
import { Mailer } from "./mailer.ts"
import { authOptions, type AuthOptionsInput } from "./options.ts"
import {
  authSessionOf,
  type AuthSession,
  type BetterAuthSession,
} from "./session-account.ts"

export type AuthConfig = Omit<
  AuthOptionsInput,
  | "sendVerificationEmail"
  | "sendResetPassword"
  | "sendChangeEmailConfirmation"
  | "sendNewEmailVerification"
  | "sendDeleteAccountLink"
  | "authorizeOwnAction"
  | "grantAdmin"
>

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
    // The account's sessions that haven't expired. Read past Better Auth's
    // list-sessions route, which refuses a session older than a day.
    readonly sessionsOf: (
      userId: string
    ) => Effect.Effect<ReadonlyArray<Session>, UnknownError>
    // Better Auth's provider ids: `credential` for a password, `google`.
    readonly providersOf: (
      userId: string
    ) => Effect.Effect<ReadonlyArray<string>, UnknownError>
  }
>()("dashboard/server/auth/Auth") {
  // Built per request: the database and secret are request-scoped bindings.
  static readonly make = (config: AuthConfig) =>
    Layer.effect(
      Auth,
      Effect.gen(function* () {
        const context = yield* Effect.context<Mailer | AdminEmails | Accounts>()
        // The cap counts through Better Auth's adapter, joining the request's
        // transaction when there is one (a second connection would wait on
        // it forever). Callbacks run only once `auth` exists.
        const run: CallbackRunner<Mailer | AdminEmails | Accounts | MailCap> =
          makeCallbackRunner(
            Context.add(
              context,
              MailCap,
              MailCap.make(() =>
                auth.$context.then((ctx) => getCurrentAdapter(ctx.adapter))
              )
            )
          )
        const adminEmails = Context.get(context, AdminEmails)
        const auth = betterAuth(
          authOptions({
            ...config,
            sendVerificationEmail: ({ email, url }) =>
              run(sendVerificationEmail(email, url)),
            sendResetPassword: ({ email, url }) =>
              run(sendResetPassword(email, url)),
            sendChangeEmailConfirmation: ({ email, newEmail, url }) =>
              run(sendChangeEmailConfirmation(email, newEmail, url)),
            sendNewEmailVerification: ({ email, url }) =>
              run(sendNewEmailVerification(email, url)),
            sendDeleteAccountLink: ({ email, url }) =>
              run(sendDeleteAccountLink(email, url)),
            grantAdmin: (user) => run(grantAdmin(user)),
            authorizeOwnAction: ({ action, session }) =>
              run(authorizeOwnAction(action, session)),
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
              Effect.map((found) =>
                found === null
                  ? null
                  : authSessionOf(
                      found satisfies BetterAuthSession,
                      adminEmails.includes
                    )
              )
            ),
          sessionsOf: (userId) =>
            Effect.tryPromise(async () => {
              const { internalAdapter } = await auth.$context
              const sessions = await internalAdapter.listSessions(userId, {
                onlyActiveSessions: true,
              })
              const now = new Date()
              return sessions.filter((session) => session.expiresAt > now)
            }),
          providersOf: (userId) =>
            Effect.tryPromise(async () => {
              const { internalAdapter } = await auth.$context
              const accounts = await internalAdapter.findAccounts(userId)
              return accounts.map((account) => account.providerId)
            }),
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
        google: googleClient(env),
        turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
      }).pipe(Layer.provideMerge(Accounts.make(env.AUTH_DB)))
    })
  ).pipe(
    Layer.provideMerge(AdminEmails.layer),
    Layer.provide(Mailer.layer),
    Layer.provide(waitUntilLive)
  )
}
