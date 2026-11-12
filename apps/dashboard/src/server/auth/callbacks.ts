// Every callback Better Auth makes into our code is an Effect, run here. A
// known failure becomes Better Auth's own APIError, so its handler answers
// with that status. Never runServerEffect: its thrown Response would bypass
// Better Auth.
import { HttpError } from "@workspace/server"
import { APIError } from "better-auth/api"
import { Cause, Effect, Schema, type Context } from "effect"

import { linkLifetime } from "../../lib/link-lifetime.ts"
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
  onAdminList,
  storedRoleOf,
  targetOf,
  type AdminList,
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
// per-address cap. CODING_STANDARDS' closed set binds server functions through
// runServerEffect; a callback answers through Better Auth, and this is the one
// place a sixth error crosses. See apinrdw/kumora#80, "Per-address cap".
//
// Fails with the APIError that answers `error`.
const toAPIError = (error: HttpError | TooManyMails) =>
  Effect.fail(
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
  )

export type CallbackRunner<R> = <A, E>(
  effect: Effect.Effect<A, E, R>
) => Promise<A>

// A known failure fails as its APIError; anything else is logged and fails as
// a 500. runPromise rejects with that APIError unchanged.
const toBetterAuth = <E>(cause: Cause.Cause<E>) => {
  const errors = cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error)
  if (!Cause.hasDies(cause) && errors.every(isKnown) && errors[0])
    return toAPIError(errors[0])
  return Effect.logError("Auth callback failed", cause).pipe(
    Effect.andThen(Effect.fail(new APIError("INTERNAL_SERVER_ERROR")))
  )
}

// Decision: the runner this builds is a plain function returning a Promise,
// not an Effect: it is the runtime Better Auth's callbacks go through, and
// Better Auth calls them with fixed Promise signatures.
export const makeCallbackRunner = <R>(
  context: Context.Context<R>
): Effect.Effect<CallbackRunner<R>> =>
  Effect.sync(() => {
    const run = Effect.runPromiseWith(context)
    return (effect) => run(Effect.catchCause(effect, toBetterAuth))
  })

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
        `The link works for ${yield* linkLifetime("verify")}. If you didn't create an account, ignore this email.`,
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
      `The link works for ${yield* linkLifetime("reset")}. Setting a new password signs you out everywhere else.`,
      "If you didn't ask for this, ignore this email; your password stays as it is.",
    ],
  })
})

// To the address of an unverified account someone signed up on again. Sent as
// the sign-up mail is, so over the cap it is only logged.
export const sendSetPassword = Effect.fn("sendSetPassword")(function* (
  email: string,
  url: string
) {
  yield* sendMail({
    to: email,
    subject: "Set your KUMORA password",
    capped: true,
    lines: [
      "A KUMORA account with this email exists but isn't verified yet. Open this link to set its password and verify your email:",
      "",
      url,
      "",
      `The link works for ${yield* linkLifetime("reset")}. Setting the password signs out every other session of the account.`,
      "If you didn't try to create an account, ignore this email.",
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
      `The link works for ${yield* linkLifetime("verify")}. Your email changes only once the new address is verified.`,
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
        `The link works for ${yield* linkLifetime("verify")}. If you didn't ask for this, ignore this email.`,
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
        `The link works for ${yield* linkLifetime("delete")}, in a browser signed in to the account. It asks once more before deleting.`,
        "If you didn't ask for this, ignore this email and change your password.",
      ],
    })
  }
)

// A Better Auth route asks the access policy first. Each reason maps as the
// spec's before-hook column says: 401, 404 or 403 (apinrdw/kumora#80,
// "Access policy"). A route has no page to return to.
const hookVerdict = (decision: Effect.Effect<Decision>) =>
  Effect.flatMap(decision, (decided) =>
    decided._tag === "Allow" ? Effect.void : refusal(decided.reason, "/")
  )

// Better Auth's session as the gates read it, or null without one.
const sessionOf = (found: BetterAuthSession | null, adminList: AdminList) =>
  found === null ? Effect.succeed(null) : authSessionOf(found, adminList)

export const authorizeOwnAction = Effect.fn("authorizeOwnAction")(function* (
  action: OwnAction,
  found: BetterAuthSession | null
) {
  const session = yield* sessionOf(found, yield* AdminEmails)
  yield* hookVerdict(decide(yield* accountOf(session), action, OWN_ACCOUNT))
})

// The links that move an account to a new email act on the account they are
// bound to, from any browser, signed in or not. The policy decides on that
// account as it is now, since ADMIN_EMAILS may have changed since the link
// was sent; the request's session says only whether an admin is viewing as
// it.
export const authorizeEmailChange = Effect.fn("authorizeEmailChange")(
  function* (user: TargetUser, found: BetterAuthSession | null) {
    const adminEmails = yield* AdminEmails
    const session = yield* sessionOf(found, adminEmails)
    const impersonated = session !== null && session.session.impersonated
    yield* hookVerdict(
      decide(
        yield* accountOfUser(user, impersonated, adminEmails),
        "own.change-email",
        OWN_ACCOUNT
      )
    )
  }
)

// Decision: an email on ADMIN_EMAILS becomes admin once it is verified, not
// when the account is created, so nobody can squat an admin email before its
// owner signs up. It runs after every write of an account; from then on the
// role lives in the database. An email listed after verification is a config
// admin at once (session-account.ts). See apinrdw/kumora#70.
export const grantAdmin = Effect.fn("grantAdmin")(function* (
  user: WrittenUser
) {
  const adminEmails = yield* AdminEmails
  if (
    !user.emailVerified ||
    (yield* storedRoleOf(user.role)) === "admin" ||
    !(yield* onAdminList(adminEmails, user.email))
  )
    return
  yield* (yield* Accounts).makeAdmin(user.id)
})

// A password set through a mailed link proves the inbox, which is what the
// verification link proves. The grant follows, as it does after that link.
export const verifyByPasswordReset = Effect.fn("verifyByPasswordReset")(
  function* (user: WrittenUser) {
    if (user.emailVerified) return
    yield* (yield* Accounts).verifyEmail(user.id)
    yield* grantAdmin({ ...user, emailVerified: true })
  }
)

// The policy allowed an admin action on the effective role; the admin plugin
// checks the stored role next, so a config admin's grant is stored now rather
// than at its next sign-in.
const storeGrant = (found: BetterAuthSession | null) =>
  found === null ? Effect.void : grantAdmin(found.user)

// The config-admin and self protections are the policy's admin rules. The
// admin plugin's own role check runs after this hook. A userId that names no
// account (`target` null) still asks the policy about the actor, through the
// admin feature's own gate, so a member or a visitor gets the same answer for
// any id; only then is it not found.
export const authorizeAdminAction = Effect.fn("authorizeAdminAction")(
  function* (
    action: TargetAction,
    found: BetterAuthSession | null,
    target: TargetUser | null
  ) {
    const adminEmails = yield* AdminEmails
    const session = yield* sessionOf(found, adminEmails)
    const account = yield* accountOf(session)
    if (target === null) {
      yield* hookVerdict(decide(account, "page.view", { feature: "admin" }))
      return yield* refusal("not-found", "/")
    }
    yield* hookVerdict(
      decide(account, action, yield* targetOf(target, session, adminEmails))
    )
    yield* storeGrant(found)
  }
)
