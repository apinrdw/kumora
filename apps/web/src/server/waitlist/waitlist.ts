// The waitlist's server side: a visitor joins with an email and gets their
// queue number. Joining again with the same email gives back the same one.
import { BadRequest } from "@workspace/server"
import { DateTime, Effect, Schema, SchemaTransformation } from "effect"

import { WaitlistDb, type WaitlistDbError } from "./db.ts"

// The longest address SMTP carries (RFC 5321's 256-octet path, less the angle
// brackets), which also caps what one visitor can store.
const EMAIL_MAX_LENGTH = 254

// Something@something.tld with no whitespace: enough to turn away a typo or
// junk, not a full RFC 5322 parse. Nothing is sent to it yet.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

// Decision: one row per trimmed, lowercased email; its queue number is the rowid
// (apps/web/docs/adr/0002-a-queue-number-is-the-waitlist-row-s-autoincrement-rowid.md)
const WaitlistEmail = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMaxLength(EMAIL_MAX_LENGTH),
      Schema.isPattern(EMAIL_SHAPE)
    ),
    SchemaTransformation.toLowerCase()
  ),
  Schema.brand("WaitlistEmail")
)

const WaitlistLang = Schema.Literals(["en", "id"])

// What the landing page sends. The email is any string here: a malformed one
// is the visitor's mistake, answered as BadRequest, not a broken request.
export const JoinWaitlistInput = Schema.Struct({
  email: Schema.String,
  lang: WaitlistLang,
})
export type JoinWaitlistInput = typeof JoinWaitlistInput.Type

export interface JoinWaitlistResult {
  // "already" when the email had joined before; the number and time are
  // that first join's.
  readonly status: "joined" | "already"
  // The queue number, from 1. The page formats the ticket.
  readonly number: number
  // Epoch milliseconds.
  readonly joinedAt: number
}

const decodeEmail = Schema.decodeUnknownEffect(WaitlistEmail)

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ number: Schema.Number, joinedAt: Schema.Number })
  )
)

// Decision: one row per trimmed, lowercased email; its queue number is the rowid
// (apps/web/docs/adr/0002-a-queue-number-is-the-waitlist-row-s-autoincrement-rowid.md)
//
// The insert runs only for a new email, and the select reads the email's row
// either way.
export const takeQueueNumber = Effect.fn("takeQueueNumber")(function* (
  input: JoinWaitlistInput
): Effect.fn.Return<
  JoinWaitlistResult,
  BadRequest | WaitlistDbError,
  WaitlistDb
> {
  const email = yield* decodeEmail(input.email).pipe(
    Effect.mapError(() => new BadRequest({ message: "invalid email" }))
  )
  const joinedAt = DateTime.toEpochMillis(yield* DateTime.now)
  const [inserted, existing] = yield* (yield* WaitlistDb).batch([
    {
      sql: "INSERT INTO waitlist (email, lang, joined_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM waitlist WHERE email = ?) RETURNING number",
      params: [email, input.lang, joinedAt, email],
    },
    {
      sql: "SELECT number, joined_at AS joinedAt FROM waitlist WHERE email = ?",
      params: [email],
    },
  ])
  const [row] = yield* decodeRows(existing).pipe(Effect.orDie)
  if (row === undefined)
    return yield* Effect.die(new Error("The waitlist row read back is missing"))
  return { status: inserted.length > 0 ? "joined" : "already", ...row }
})
