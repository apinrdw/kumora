// Every callback Better Auth makes into our code is an Effect, run here. A
// known failure becomes Better Auth's own APIError, so its handler answers
// with that status. Never runServerEffect: its thrown Response would bypass
// Better Auth.
import { HttpError } from "@workspace/server"
import { APIError } from "better-auth/api"
import { Cause, Effect, Exit, Schema, type Context } from "effect"

import { RETRY_AFTER_HEADER } from "../../lib/retry-after.ts"
import { Accounts } from "./accounts.ts"
import { AdminEmails } from "./admin-emails.ts"
import { MailCap, TooManyMails } from "./mail-cap.ts"
import { Mailer } from "./mailer.ts"
import type { TargetUser, WrittenUser } from "./options.ts"
import {
  OWN_ACCOUNT,
  decide,
  type Decision,
  type OwnAction,
  type TargetAction,
} from "./policy.ts"
import { refusal } from "./refusal.ts"
import {
  accountOf,
  accountOfUser,
  authSessionOf,
  storedRoleOf,
  targetOf,
  type BetterAuthSession,
} from "./session-account.ts"

const isKnown = Schema.is(Schema.Union([HttpError, TooManyMails]))

const STATUS = {
  NotFound: "NOT_FOUND",
  BadRequest: "BAD_REQUEST",
  Forbidden: "FORBIDDEN",
  Conflict: "CONFLICT",
  Unauthorized: "UNAUTHORIZED",
} as const satisfies Record<HttpError["_tag"], string>

// Decision: TooManyMails crosses to HTTP as a 429 with a retry header beside
// the closed HttpError set, because the spec prescribes that answer for the
// per-address cap (apinrdw/kumora#80, "Per-address cap"). CODING_STANDARDS
// ("Only the closed error set crosses to HTTP") binds server functions through
// runServerEffect; a callback answers through Better Auth instead, and this
// mapping is the one place a sixth error crosses.
const toAPIError = (error: HttpError | TooManyMails) =>
  error._tag === "TooManyMails"
    ? new APIError(
        "TOO_MANY_REQUESTS",
        { code: error._tag, message: "Too many requests. Try again later." },
        { [RETRY_AFTER_HEADER]: String(error.retryAfter) }
      )
    : new APIError(STATUS[error._tag], {
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
    if (!Cause.hasDies(exit.cause) && errors.every(isKnown) && errors[0])
      throw toAPIError(errors[0])
    await run(Effect.logError("Auth callback failed", exit.cause))
    throw new APIError("INTERNAL_SERVER_ERROR")
  }
}

// One mail to one address. A capped mail counts toward the address's daily
// cap first (mail-cap.ts); over it, the send fails with TooManyMails.
const sendMail = Effect.fnUntraced(function* (mail: {
  readonly to: string
  readonly subject: string
  readonly lines: ReadonlyArray<string>
  readonly capped: boolean
}) {
  if (mail.capped) yield* (yield* MailCap).take(mail.to)
  yield* (yield* Mailer).send({
    to: mail.to,
    subject: mail.subject,
    text: mail.lines.join("\r\n"),
  })
})

export const sendVerificationEmail = Effect.fn("sendVerificationEmail")(
  function* (email: string, url: string) {
    yield* sendMail({
      to: email,
      subject: "Verify your email for KUMORA",
      capped: true,
      lines: [
        "Open this link to verify your email and finish creating your KUMORA account:",
        "",
        url,
        "",
        "The link works for 24 hours. If you didn't create an account, ignore this email.",
      ],
    })
  }
)

// Better Auth runs this send in the background and only logs its failure, so
// a capped address still sees the neutral "Reset link sent".
export const sendResetPassword = Effect.fn("sendResetPassword")(function* (
  email: string,
  url: string
) {
  yield* sendMail({
    to: email,
    subject: "Reset your KUMORA password",
    capped: true,
    lines: [
      "Open this link to choose a new password for your KUMORA account:",
      "",
      url,
      "",
      "The link works for 1 hour. Setting a new password signs you out everywhere else.",
      "If you didn't ask for this, ignore this email; your password stays as it is.",
    ],
  })
})

export const sendChangeEmailConfirmation = Effect.fn(
  "sendChangeEmailConfirmation"
)(function* (email: string, newEmail: string, url: string) {
  yield* sendMail({
    to: email,
    subject: "Confirm your new KUMORA email",
    capped: false,
    lines: [
      `Someone asked to move your KUMORA account to ${newEmail}.`,
      "Open this link to confirm, and we'll send a link to the new address to verify it:",
      "",
      url,
      "",
      "The link works for 24 hours. Your email changes only once the new address is verified.",
      "If you didn't ask for this, ignore this email and change your password.",
    ],
  })
})

export const sendNewEmailVerification = Effect.fn("sendNewEmailVerification")(
  function* (email: string, url: string) {
    yield* sendMail({
      to: email,
      subject: "Verify your new KUMORA email",
      // A verification mail, so it counts toward the new address's cap.
      // Better Auth sends it in the background, so over the cap it is only
      // logged.
      capped: true,
      lines: [
        "Open this link to verify this address and make it your KUMORA account's email:",
        "",
        url,
        "",
        "The link works for 24 hours. If you didn't ask for this, ignore this email.",
      ],
    })
  }
)

export const sendDeleteAccountLink = Effect.fn("sendDeleteAccountLink")(
  function* (email: string, url: string) {
    yield* sendMail({
      to: email,
      subject: "Delete your KUMORA account",
      capped: false,
      lines: [
        "Open this link to delete your KUMORA account, its sessions and its sign-in methods:",
        "",
        url,
        "",
        "The link works for 1 hour, in a browser signed in to the account. It asks once more before deleting.",
        "If you didn't ask for this, ignore this email and change your password.",
      ],
    })
  }
)

// A Better Auth route asks the access policy first. Each reason maps as the
// spec's before-hook column says: 401, 404 or 403 (apinrdw/kumora#80,
// "Access policy"). A route has no page to return to.
const hookVerdict = (decision: Decision) =>
  decision._tag === "Allow"
    ? Effect.void
    : Effect.fail(refusal(decision.reason, "/"))

export const authorizeOwnAction = Effect.fn("authorizeOwnAction")(function* (
  action: OwnAction,
  found: BetterAuthSession | null
) {
  const adminEmails = yield* AdminEmails
  const session = found && authSessionOf(found, adminEmails)
  yield* hookVerdict(decide(accountOf(session), action, OWN_ACCOUNT))
})

// The links that move an account to a new email act on the account they are
// bound to, from any browser, signed in or not. The policy decides on that
// account as it is now, since ADMIN_EMAILS may have changed since the link
// was sent; the request's session says only whether an admin is viewing as
// it.
export const authorizeEmailChange = Effect.fn("authorizeEmailChange")(
  function* (user: TargetUser, found: BetterAuthSession | null) {
    const adminEmails = yield* AdminEmails
    const impersonated =
      found !== null && authSessionOf(found, adminEmails).session.impersonated
    yield* hookVerdict(
      decide(
        accountOfUser(user, impersonated, adminEmails),
        "own.change-email",
        OWN_ACCOUNT
      )
    )
  }
)

// Decision: an email on ADMIN_EMAILS becomes admin once it is verified, not
// when the account is created, so nobody can squat an admin email before its
// owner signs up. It runs after every write of an account, which covers the
// verification link, a sign-up through a provider that already verified the
// email (Google), and a change to an email on the list. From then on the role
// lives in the database. An email put on the list after it was verified is a
// config admin at once (session-account.ts) and is stored as admin here at its
// next sign-in or admin action, whichever comes first. See apinrdw/kumora#70.
export const grantAdmin = Effect.fn("grantAdmin")(function* (
  user: WrittenUser
) {
  const adminEmails = yield* AdminEmails
  if (
    !user.emailVerified ||
    storedRoleOf(user.role) === "admin" ||
    !adminEmails.includes(user.email)
  )
    return
  yield* (yield* Accounts).makeAdmin(user.id)
})

// The policy allowed an admin action on the effective role; the admin plugin
// checks the stored role next, so a config admin's grant is stored now rather
// than at its next sign-in.
const storeGrant = (found: BetterAuthSession | null) =>
  found === null ? Effect.void : grantAdmin(found.user)

export const authorizeListAccounts = Effect.fn("authorizeListAccounts")(
  function* (found: BetterAuthSession | null) {
    const adminEmails = yield* AdminEmails
    const session = found && authSessionOf(found, adminEmails)
    yield* hookVerdict(
      decide(accountOf(session), "admin.list-accounts", { feature: "admin" })
    )
    yield* storeGrant(found)
  }
)

// The config-admin and self protections are the policy's admin rules. The
// admin plugin's own role check runs after this hook.
export const authorizeAdminAction = Effect.fn("authorizeAdminAction")(
  function* (
    action: TargetAction,
    found: BetterAuthSession | null,
    target: TargetUser
  ) {
    const adminEmails = yield* AdminEmails
    const session = found && authSessionOf(found, adminEmails)
    yield* hookVerdict(
      decide(accountOf(session), action, targetOf(target, session, adminEmails))
    )
    yield* storeGrant(found)
  }
)
