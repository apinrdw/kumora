// Every callback Better Auth makes into our code is an Effect, run here. A
// known failure becomes Better Auth's own APIError, so its handler answers
// with that status. Never runServerEffect: its thrown Response would bypass
// Better Auth.
import { HttpError } from "@workspace/server"
import { APIError } from "better-auth/api"
import { Cause, Effect, Exit, Schema, type Context } from "effect"

import { Accounts, roleOf } from "./accounts.ts"
import { AdminEmails } from "./admin-emails.ts"
import { Mailer } from "./mailer.ts"
import type { WrittenUser } from "./options.ts"

const isHttpError = Schema.is(HttpError)

const STATUS = {
  NotFound: "NOT_FOUND",
  BadRequest: "BAD_REQUEST",
  Forbidden: "FORBIDDEN",
  Conflict: "CONFLICT",
  Unauthorized: "UNAUTHORIZED",
} as const satisfies Record<HttpError["_tag"], string>

const toAPIError = (error: HttpError) =>
  new APIError(STATUS[error._tag], {
    code: error._tag,
    message: "message" in error ? error.message : undefined,
  })

export type CallbackRunner<R> = <A, E>(
  effect: Effect.Effect<A, E, R>
) => Promise<A>

export function makeCallbackRunner<R>(
  context: Context.Context<R>
): CallbackRunner<R> {
  const run = Effect.runPromiseWith(context)
  return async (effect) => {
    const exit = await Effect.runPromiseExitWith(context)(effect)
    if (Exit.isSuccess(exit)) return exit.value
    const errors = exit.cause.reasons
      .filter(Cause.isFailReason)
      .map((reason) => reason.error)
    if (!Cause.hasDies(exit.cause) && errors.every(isHttpError) && errors[0])
      throw toAPIError(errors[0])
    await run(Effect.logError("Auth callback failed", exit.cause))
    throw new APIError("INTERNAL_SERVER_ERROR")
  }
}

export const sendVerificationEmail = Effect.fn("sendVerificationEmail")(
  function* (email: string, url: string) {
    const mailer = yield* Mailer
    yield* mailer.send({
      to: email,
      subject: "Verify your email for KUMORA",
      text: [
        "Open this link to verify your email and finish creating your KUMORA account:",
        "",
        url,
        "",
        "The link works for 24 hours. If you didn't create an account, ignore this email.",
      ].join("\r\n"),
    })
  }
)

export const sendResetPassword = Effect.fn("sendResetPassword")(function* (
  email: string,
  url: string
) {
  const mailer = yield* Mailer
  yield* mailer.send({
    to: email,
    subject: "Reset your KUMORA password",
    text: [
      "Open this link to choose a new password for your KUMORA account:",
      "",
      url,
      "",
      "The link works for 1 hour. Setting a new password signs you out everywhere else.",
      "If you didn't ask for this, ignore this email; your password stays as it is.",
    ].join("\r\n"),
  })
})

// Decision: an email on ADMIN_EMAILS becomes admin once it is verified, not
// when the account is created, so nobody can squat an admin email before its
// owner signs up. It runs after every write of an account, which covers the
// verification link, a sign-up through a provider that already verified the
// email (Google), and a change to an email on the list. From then on the role
// lives in the database. See apinrdw/kumora#70.
export const grantAdmin = Effect.fn("grantAdmin")(function* (
  user: WrittenUser
) {
  const adminEmails = yield* AdminEmails
  if (
    !user.emailVerified ||
    roleOf(user.role) === "admin" ||
    !adminEmails.includes(user.email)
  )
    return
  yield* (yield* Accounts).makeAdmin(user.id)
})
