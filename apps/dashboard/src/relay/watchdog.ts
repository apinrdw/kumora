// Recovers a silent Stockbit tab. Stockbit's subscription follows a REST
// `is_open_market` flag, so the widget can stay mounted with no subscription. The
// object keeps this state in storage, because it hibernates between alarms.
import type { IsoDateTime } from "@/domain/time"

import type { Phase } from "./calendar"
import { tradingDay } from "./trading-day"

const QUIET_MS = 60_000

/** The extension keeps a copy, `RecoveryStep` in its src/protocol.ts. */
export type RecoveryStep = "reopen-widget" | "reload-tab"

export type Watchdog = {
  /** The trading day and phase it belongs to: another session starts again. */
  readonly session: string
  readonly taken: RecoveryStep | null
  /** Epoch ms the quiet is measured from: a trade, a step, or the ingest's arrival. */
  readonly since: number
}

export type WatchdogInput = {
  readonly now: number
  readonly phase: Phase
  readonly lastTradeAt: IsoDateTime | null
  /** Whether an ingest holds the active role. */
  readonly active: boolean
}

const NEXT = {
  none: "reopen-widget",
  "reopen-widget": "reload-tab",
  "reload-tab": null,
} as const

/** One alarm's turn. An unchanged state comes back as the same object. */
export const watchdog = (
  stored: Watchdog | null,
  { now, phase, lastTradeAt, active }: WatchdogInput
): { state: Watchdog | null; send: RecoveryStep | null } => {
  if (phase !== "session-1" && phase !== "session-2")
    return { state: null, send: null }

  const session = `${tradingDay(new Date(now).toISOString())}/${phase}`
  let state = stored?.session === session ? stored : null
  const traded = lastTradeAt === null ? null : Date.parse(lastTradeAt)
  if (state && traded !== null && traded > state.since)
    state = { session, taken: null, since: traded }

  if (!active) return { state: state && { ...state, since: now }, send: null }
  if (!state) return { state: { session, taken: null, since: now }, send: null }

  const next = NEXT[state.taken ?? "none"]
  if (next === null || now - state.since < QUIET_MS)
    return { state, send: null }
  return { state: { session, taken: next, since: now }, send: next }
}
