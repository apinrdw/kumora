// What the Worker (entry.ts, live-viewers.ts) and the trading-day Durable
// Object (trading-day-object.ts) agree on when they talk.
import { Schema } from "effect"

// The object's own paths. The entry builds a new request to them, so no
// header a client sent reaches the object.
// A recorded day GET reaches the object at its own path under
// `/market-live/days/`, with no header the client sent.
export const ObjectPath = {
  ingest: "/ingest",
  live: "/live",
  endSessions: "/end-sessions",
  // A broker codes batch (POST) or the day's status (GET), the token already
  // checked by the entry (broker-codes-route.ts).
  brokerCodes: "/broker-codes",
  // The reconcile cron's poke (POST) to build the day's broker totals
  // (src/server/broker-totals/reconcile.ts). No Worker route reaches it.
  brokerTotals: "/broker-totals",
} as const

// The index Durable Object (day-index-object.ts): one, by this name. A day's
// object POSTs its row to its path at the seal; the Worker GETs the strip
// from it.
export const DAY_INDEX = "index"
export const DayIndexPath = "/days"
// A day's move to R2 POSTs its date here once its manifest is written
// (cold-days.ts): the strip then carries it as cold.
export const DayIndexColdPath = "/cold"

// An account's id and one of its sessions' ids, as Better Auth names them.
export const AccountId = Schema.NonEmptyString.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type
export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

// The gated viewer's account, session and the session's end; the object tags
// the socket with them. The end is epoch ms on Market Live's clock, the one
// the object compares it against (market-clock.ts).
export const ViewerHeader = {
  userId: "x-kumora-user-id",
  sessionId: "x-kumora-session-id",
  sessionEnd: "x-kumora-session-end",
} as const
export const SessionEnd = Schema.FiniteFromString

// Sent to ObjectPath.endSessions after a ban, revoke or delete: the sessions
// the user still holds. The object closes the user's viewer sockets on every
// other session.
export const HeldSessions = Schema.Struct({
  userId: AccountId,
  sessionIds: Schema.Array(SessionId),
})
export type HeldSessions = typeof HeldSessions.Type

// A sealed day's answers never change, so the browser keeps them (spec
// apinrdw/kumora#138, "Recorded day loads").
export const SEALED_CACHE = "private, max-age=31536000, immutable"
