// The browser's tape: a store over one WebSocket per page view, folded by a pure
// reducer. No `effect` here, and the domain only as types.
import { useMemo, useSyncExternalStore } from "react"

import type { Symbol } from "@/domain/symbol"
import type {
  LiveQuote,
  RelayStatus,
  StaleReason,
  Sweep,
  TapeBackfill,
  TapeProvenance,
  ThresholdState,
  Trade,
  TradeFrame,
  Wall,
} from "@/domain/trade"
import { REGULAR_BOARD } from "@/relay/exchange"
import { NO_QUOTE, applyTrades, lastRgTrade } from "@/relay/quote"
import { OFF_BOARD_KEEP, TAPE_KEEP } from "@/relay/routes"
import { tradingDay } from "@/relay/trading-day"

import { relayTicket } from "./query"
import { createRelayStore } from "./relay-store"
import type { RelayEvent, RelaySocket } from "./relay-store"

export type TapeState = {
  readonly trades: ReadonlyArray<Trade>
  /** The session's off-board trades, newest first: apart from `trades`, which a busy symbol scrolls past them. */
  readonly offBoard: ReadonlyArray<Trade>
  readonly seq: number
  readonly provenance: TapeProvenance
  /** The hero's figures. Their as-of is theirs: an NG trade moves the tape, not the quote. */
  readonly quote: LiveQuote
  readonly quoteAsOf: TapeProvenance["asOf"]
  /** The trading day on the page, once known. A later one means the relay cleared. */
  readonly day: string | null
  readonly status: RelayStatus | null
  readonly socket: RelaySocket
  readonly reconnects: number
  /** Newest first. The browser never judges a trade: rows arrive whole, by key. */
  readonly sweeps: ReadonlyArray<Sweep>
  /** Newest first. */
  readonly walls: ReadonlyArray<Wall>
  readonly threshold: ThresholdState
  readonly wallCoverage: boolean
  /** The walls' own feed, which goes stale apart from the tape's. */
  readonly liveprice: TapeProvenance
}

export type TapeEvent = RelayEvent

/** The browser only demotes. Only the relay writes `live`. */
export const demote = (p: TapeProvenance): TapeProvenance =>
  p.freshness === "live" ? { ...p, freshness: "stale" } : p

/** The two pills a page with both feeds shows. */
type Provenances = {
  readonly provenance: TapeProvenance
  readonly liveprice: TapeProvenance
}

/** Both pills after a silence: the same state if neither was live. */
export const demoteProvenances = <S extends Provenances>(state: S): S => {
  const provenance = demote(state.provenance)
  const liveprice = demote(state.liveprice)
  return provenance === state.provenance && liveprice === state.liveprice
    ? state
    : { ...state, provenance, liveprice }
}

/** What a new trading day leaves: the last day's figures must not read as today's. */
const cleared = (state: TapeState, day: string): TapeState => ({
  ...state,
  day,
  trades: [],
  offBoard: [],
  quote: NO_QUOTE,
  quoteAsOf: null,
  provenance: { ...state.provenance, asOf: null },
  sweeps: [],
  walls: [],
  threshold: {
    symbol: state.threshold.symbol,
    threshold: null,
    warmingUp: true,
    prior: "none",
    ordersToday: 0,
    asOf: null,
  },
})

const rollDay = (state: TapeState, day: string | null): TapeState => {
  if (day === null || day === state.day) return state
  return state.day === null || day > state.day
    ? cleared(state, day)
    : { ...state, day }
}

/** A trade's identity: (day, symbol, trade number). */
const tradeKey = (t: Trade) =>
  `${tradingDay(t.tradedAt)}:${t.symbol}:${t.tradeNumber}`

const latestTradeFirst = (a: Trade, b: Trade) =>
  b.tradedAt.localeCompare(a.tradedAt) || b.tradeNumber - a.tradeNumber

/** Adds the off-board trades among `trades` to the held ones, once per identity, newest first. */
export const mergeOffBoard = (
  held: ReadonlyArray<Trade>,
  trades: ReadonlyArray<Trade>
): ReadonlyArray<Trade> => {
  const seen = new Set(held.map(tradeKey))
  const added: Array<Trade> = []
  for (const trade of trades) {
    const key = tradeKey(trade)
    if (trade.board === REGULAR_BOARD || seen.has(key)) continue
    seen.add(key)
    added.push(trade)
  }
  return added.length === 0
    ? held
    : [...held, ...added].sort(latestTradeFirst).slice(0, OFF_BOARD_KEEP)
}

type FrameOf<T extends TradeFrame["type"]> = Extract<TradeFrame, { type: T }>

/** What a status says of a page's two pills. The walls' reads live while any frame arrived across the coverage, a quiet symbol's page too. */
export const provenancesFromStatus = (
  held: Provenances,
  status: RelayStatus
): Provenances => ({
  provenance: {
    ...held.provenance,
    source: status.source,
    freshness: status.freshness,
    asOf: held.provenance.asOf ?? status.lastTradeAt,
  },
  liveprice: {
    ...held.liveprice,
    source: status.source,
    freshness:
      status.source !== "none" && status.wallCoverage.some((c) => c.receiving)
        ? "live"
        : "stale",
  },
})

const onStatus = (
  state: TapeState,
  { status }: FrameOf<"status">
): TapeState => {
  // A quiet symbol hears a day clear only from the status frame.
  const rolled = rollDay(state, status.day)
  return {
    ...rolled,
    status,
    ...provenancesFromStatus(rolled, status),
    wallCoverage: status.wallCoverage.some(
      (c) => c.symbol === rolled.threshold.symbol
    ),
  }
}

const onTrades = (state: TapeState, frame: FrameOf<"trades">): TapeState => {
  if (frame.seq <= state.seq) return state
  const newest = [...frame.trades].reverse()
  const first = newest[0]
  // A day clear on the relay reaches the page as its first new trade.
  const rolled = rollDay(state, first ? tradingDay(first.tradedAt) : null)
  return {
    ...rolled,
    seq: frame.seq,
    provenance: frame.provenance,
    quote: applyTrades(rolled.quote, frame.trades),
    quoteAsOf: lastRgTrade(frame.trades)
      ? frame.provenance.asOf
      : rolled.quoteAsOf,
    trades: newest.concat(rolled.trades).slice(0, TAPE_KEEP),
    offBoard: mergeOffBoard(rolled.offBoard, frame.trades),
  }
}

/** One row per key, whatever order or how many times its frames arrive. */
export const upsert = <T>(
  rows: ReadonlyArray<T>,
  row: T,
  same: (a: T) => boolean,
  newestFirst: (a: T, b: T) => number
): ReadonlyArray<T> => [...rows.filter((r) => !same(r)), row].sort(newestFirst)

export const sameWall = (a: Wall) => (b: Wall) =>
  a.day === b.day &&
  a.symbol === b.symbol &&
  a.firstOrderNumber === b.firstOrderNumber

export const sameSweep = (a: Sweep) => (b: Sweep) =>
  a.day === b.day && a.symbol === b.symbol && a.firstNumber === b.firstNumber

/** Walls by their key, newest first. */
export const upsertWall = (walls: ReadonlyArray<Wall>, wall: Wall) =>
  upsert(walls, wall, sameWall(wall), (a, b) =>
    b.firstSeen.localeCompare(a.firstSeen)
  )

/** A resumed row can be older than what the page shows, and must not move its as-of back. */
export const latest = (
  held: TapeProvenance,
  next: TapeProvenance
): TapeProvenance => ({
  ...next,
  asOf:
    held.asOf !== null && (next.asOf === null || held.asOf > next.asOf)
      ? held.asOf
      : next.asOf,
})

/** Leaves `seq` alone: it is the resume point for trades, whose frames it would drop. */
const onSweep = (state: TapeState, frame: FrameOf<"sweep">): TapeState => {
  const { sweep } = frame
  const rolled = rollDay(state, sweep.day)
  return {
    ...rolled,
    provenance: latest(rolled.provenance, frame.provenance),
    threshold: frame.threshold,
    sweeps: upsert(
      rolled.sweeps,
      sweep,
      sameSweep(sweep),
      (a, b) =>
        b.announcedAt.localeCompare(a.announcedAt) ||
        b.firstNumber - a.firstNumber
    ),
  }
}

const onWall = (state: TapeState, frame: FrameOf<"wall">): TapeState => {
  const { wall } = frame
  const rolled = rollDay(state, wall.day)
  return {
    ...rolled,
    liveprice: latest(rolled.liveprice, frame.provenance),
    threshold: frame.threshold,
    walls: upsertWall(rolled.walls, wall),
  }
}

const onFrame = (state: TapeState, frame: TradeFrame): TapeState => {
  switch (frame.type) {
    case "status":
      return onStatus(state, frame)
    case "quote":
      return { ...state, quote: frame.quote, quoteAsOf: frame.provenance.asOf }
    case "trades":
      return onTrades(state, frame)
    case "sweep":
      return onSweep(state, frame)
    case "wall":
      return onWall(state, frame)
    case "threshold":
      return { ...state, threshold: frame.threshold }
  }
}

const onSocket = (
  state: TapeState,
  socket: TapeState["socket"]
): TapeState => ({
  ...state,
  socket,
  reconnects:
    state.reconnects +
    (socket === "connecting" && state.socket === "closed" ? 1 : 0),
  provenance: socket === "closed" ? demote(state.provenance) : state.provenance,
  liveprice: socket === "closed" ? demote(state.liveprice) : state.liveprice,
})

export const reduceTape = (state: TapeState, event: TapeEvent): TapeState => {
  switch (event.type) {
    case "frame":
      return onFrame(state, event.frame)
    case "socket":
      return onSocket(state, event.socket)
    case "silent":
      return demoteProvenances(state)
  }
}

const STALE_COPY: Record<StaleReason, string> = {
  closed: "Closed",
  break: "Break",
  "no-source": "No source",
  "no-trades": "No trades",
}

/** The reason beside a STALE pill. Only the relay knows one, and only once its status arrives. */
export const staleCopy = ({ provenance, status }: TapeState): string | null =>
  provenance.freshness === "stale" && status?.reason
    ? STALE_COPY[status.reason]
    : null

/** High and low widen on the page to include the last price. An unknown one stays a dash. */
export const widenToLast = (quote: LiveQuote): LiveQuote => {
  const { last, high, low } = quote
  if (last === null) return quote
  return {
    ...quote,
    high: high === null ? null : Math.max(high, last),
    low: low === null ? null : Math.min(low, last),
  }
}

export const tapeState = (backfill: TapeBackfill): TapeState => ({
  trades: backfill.trades,
  offBoard: backfill.offBoard,
  seq: backfill.seq,
  provenance: backfill.provenance,
  quote: backfill.quote,
  quoteAsOf: backfill.quoteAsOf,
  day: backfill.day,
  status: null,
  socket: "idle",
  reconnects: 0,
  sweeps: backfill.sweeps,
  walls: backfill.walls,
  threshold: backfill.threshold,
  wallCoverage: backfill.wallCoverage,
  liveprice: backfill.liveprice,
})

export const createTapeStore = (symbol: Symbol, backfill: TapeBackfill) =>
  createRelayStore<TapeState>({
    symbol,
    initial: tapeState(backfill),
    reduce: reduceTape,
    ticket: () => relayTicket({ data: { symbol } }),
  })

/** The live tape for one symbol, seeded from the loader's backfill. */
export const useTape = (symbol: Symbol, backfill: TapeBackfill): TapeState => {
  const store = useMemo(
    () => createTapeStore(symbol, backfill),
    [symbol, backfill]
  )
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
}
