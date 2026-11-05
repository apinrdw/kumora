// What the Worker, the object, the browser's tape and the scripts must agree on.
// Free of `effect`, `cloudflare:workers` and secret names, because the focus chunk
// imports it. The extension cannot import from here, so it keeps copies:
// `INGEST_PROTOCOL` in apps/stockbit-relay-extension/src/protocol.ts, `PING` in
// apps/stockbit-relay-extension/src/background.ts, and the two
// `/api/relay` paths in apps/stockbit-relay-extension/src/options/relay-api.ts.
import type { Symbol } from "../domain/symbol"

/** The name of the one `TradeRelay` per environment. */
export const RELAY_NAME = "idx"

export const INGEST_PATH = "/ws/ingest"
export const TRADES_PATH = "/ws/trades"
/** The query keys of a `TRADES_PATH` upgrade. */
export const TRADES_QUERY = {
  symbol: "symbol",
  since: "since",
  ticket: "ticket",
} as const
/** The `symbol` of the whale radar's socket, which hears every symbol's rows. */
export const MARKET = "*"
/** What a `TRADES_PATH` ticket opens. */
export type TicketSubject = Symbol | typeof MARKET
export const STATUS_PATH = "/api/relay/status"
export const OWN_SESSION_PATH = "/api/relay/upstream"

/**
 * The whale radar's live page, which routes/radar_.live.tsx serves, and the search
 * key its symbol rides in. `.github/workflows/extension-driver.yml` cannot import
 * this, so it repeats the path.
 */
export const LIVE_PAGE_PATH = "/radar/live"
export const LIVE_PAGE_SEARCH = { symbol: "s" } as const

/** The ingest's subprotocol, the only one it offers. The secret is its first message, `auth`. */
export const INGEST_PROTOCOL = "kumora-relay"

/**
 * Why the relay closed a socket on `INGEST_PATH`, before or after its auth. One
 * code per reason, so the close code alone names the reason, as
 * `scripts/replay-stockbit-frames.mts` logs it.
 */
export const INGEST_CLOSE = {
  noPing: 4000,
  /** A first message that is not an auth with the ingest secret. */
  unauthorized: 4001,
  /** No auth message within `AUTH_MS` of connecting. */
  noAuth: 4002,
  /** A newer ingest from the same install became the active ingest. */
  replaced: 4003,
} as const

/** The liveness text frame, and the Hibernation API's auto-response to it. */
export const PING = "ping"
export const PONG = "pong"

/** What the radar loads, resumes, or carries on with at a time. The browser reads a full resume as a gap. */
export const SWEEP_PAGE = 500

/** How long an aggressor order stays open with no trade. The relay closes on it and the pages say it. */
export const ORDER_CLOSE_MS = 500

/** The share of a symbol's aggressor orders the whale threshold sits above. The relay ranks on it and the pages say it. */
export const THRESHOLD_PERCENTILE = 0.99

/** The newest trades from every board a symbol's page holds. The relay backfills this many and the browser caps at it. */
export const TAPE_KEEP = 200

/** The session's off-board trades a symbol's page holds, newest first. The relay backfills this many and the browser caps at it. */
export const OFF_BOARD_KEEP = 500
