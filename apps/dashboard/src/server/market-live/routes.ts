// What the Worker (entry.ts, live-viewers.ts) and the trading-day Durable
// Object (trading-day-object.ts) agree on when they talk.
import { Schema } from "effect"

// The object's own paths. The entry builds a new request to them, so no
// header a client sent reaches the object.
export const ObjectPath = {
  ingest: "/ingest",
  live: "/live",
  endSessions: "/end-sessions",
} as const

// The gated viewer's user and session; the object tags the socket with them.
export const ViewerHeader = {
  userId: "x-kumora-user-id",
  sessionId: "x-kumora-session-id",
} as const

// Sent to ObjectPath.endSessions after a ban, revoke or delete: the sessions
// the user still holds. The object closes the user's viewer sockets on every
// other session.
export const HeldSessions = Schema.Struct({
  userId: Schema.String,
  sessionIds: Schema.Array(Schema.String),
})
export type HeldSessions = typeof HeldSessions.Type
