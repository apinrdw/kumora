// What the Worker entry (entry.ts) and the trading-day Durable Object
// (trading-day-object.ts) agree on when the entry hands a socket over.

// The object's own paths. The entry builds a new request to them, so no
// header a client sent reaches the object.
export const ObjectPath = {
  ingest: "/ingest",
  live: "/live",
  codes: "/codes",
} as const

// The gated viewer's user and session; the object tags the socket with them.
export const ViewerHeader = {
  userId: "x-kumora-user-id",
  sessionId: "x-kumora-session-id",
} as const
