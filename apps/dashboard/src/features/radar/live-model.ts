// The whale radar live page's figures, as pure functions of the rows the relay sends.
// The browser never judges a trade here. No `effect`, and the domain only as types.
import { isSymbol } from "@/domain/symbol-guard"
import type { Symbol } from "@/domain/symbol"
import type {
  LeaderboardEntry,
  MinuteCandle,
  Sweep,
  Wall,
} from "@/domain/trade"
import {
  lots,
  money,
  priceRange,
  sweepDetail,
  wallState,
  wib,
} from "./whale-format"
import { plain } from "@/lib/format"
import { MINUTE_MS, periodOf } from "@/relay/candles"
import { SHARES_PER_LOT } from "@/relay/exchange"
import { LIVE_PAGE_SEARCH } from "@/relay/routes"

export type LiveSearch = {
  readonly [LIVE_PAGE_SEARCH.symbol]?: Symbol | undefined
}

export const parseLiveSearch = (raw: Record<string, unknown>): LiveSearch => {
  const value = raw[LIVE_PAGE_SEARCH.symbol]
  const wanted = typeof value === "string" ? value.toUpperCase() : undefined
  return { [LIVE_PAGE_SEARCH.symbol]: isSymbol(wanted) ? wanted : undefined }
}

export const CANDLE_PERIODS = [
  { label: "1m", ms: MINUTE_MS },
  { label: "5m", ms: 5 * MINUTE_MS },
  { label: "15m", ms: 15 * MINUTE_MS },
  { label: "1h", ms: 60 * MINUTE_MS },
] as const
export type CandlePeriod = (typeof CANDLE_PERIODS)[number]
/** The page opens on this one, as the reference does. */
export const DEFAULT_PERIOD: CandlePeriod = CANDLE_PERIODS[1]

export const EVENT_TYPES = [
  "Sweep Buy",
  "Sweep Sell",
  "Bid Wall",
  "Offer Wall",
] as const
export type WhaleEventType = (typeof EVENT_TYPES)[number]
export type EventFilter = WhaleEventType | "All"
export const EVENT_FILTERS: ReadonlyArray<EventFilter> = ["All", ...EVENT_TYPES]

export const sweepType = ({ side }: Sweep): WhaleEventType =>
  side === "buy" ? "Sweep Buy" : "Sweep Sell"

export const wallType = ({ side }: Wall): WhaleEventType =>
  side === "bid" ? "Bid Wall" : "Offer Wall"

export type WhaleEvent = {
  readonly key: string
  readonly type: WhaleEventType
  readonly at: string
  readonly detail: string
  /** Text, because a wall's figures are lower bounds. */
  readonly lots: string
  readonly value: string
  /** Still changing: a growing sweep, a holding wall. */
  readonly live: boolean
}

const count = (n: number, one: string) =>
  `${plain(n)} ${one}${n === 1 ? "" : "s"}`

const sweepEvent = (s: Sweep): WhaleEvent => ({
  key: `sweep:${s.day}:${s.symbol}:${s.firstNumber}`,
  type: sweepType(s),
  at: s.tradedAt,
  detail: `1 aggressive ${s.side} order took ${count(s.freq, "trade")} at ${priceRange(s)} · ${sweepDetail(s)}`,
  lots: lots(s.lots),
  value: money(s.value),
  live: s.open,
})

const wallValue = ({ lotsMatched, price }: Wall) =>
  lotsMatched * SHARES_PER_LOT * price

const wallEvent = (w: Wall): WhaleEvent => ({
  key: `wall:${w.day}:${w.symbol}:${w.firstOrderNumber}`,
  type: wallType(w),
  at: w.firstSeen,
  detail: `Resting ${w.side} at ${plain(w.price)} took ≥${count(w.hitsSeen, "hit")} · ${wallState(w)} · threshold ${lots(w.threshold)} lots${w.warmingUp ? ", warming up" : ""}`,
  lots: `≥${lots(w.lotsMatched)}`,
  value: `≥${money(wallValue(w))}`,
  live: w.closedAt === null,
})

/** Sweeps and walls as one feed, newest first. */
export const whaleEvents = (
  sweeps: ReadonlyArray<Sweep>,
  walls: ReadonlyArray<Wall>
): ReadonlyArray<WhaleEvent> =>
  [...sweeps.map(sweepEvent), ...walls.map(wallEvent)].sort(
    (a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)
  )

export const filterEvents = (
  events: ReadonlyArray<WhaleEvent>,
  filter: EventFilter
) => (filter === "All" ? events : events.filter((e) => e.type === filter))

export const eventCounts = (
  events: ReadonlyArray<WhaleEvent>
): Record<EventFilter, number> => {
  const counts: Record<EventFilter, number> = {
    All: events.length,
    "Sweep Buy": 0,
    "Sweep Sell": 0,
    "Bid Wall": 0,
    "Offer Wall": 0,
  }
  for (const { type } of events) counts[type]++
  return counts
}

/** +111,5K. The sign is always shown, and `id-ID` keeps the decimal comma, as the pages' lots do. */
export const signedLots = (n: number) => {
  const a = Math.abs(n)
  const s = n < 0 ? "-" : "+"
  if (a >= 1e6) return `${s}${plain(a / 1e6, 2)}M`
  if (a >= 1e3) return `${s}${plain(a / 1e3, 1)}K`
  return `${s}${plain(a)}`
}

/** +3,24B or -245M. */
export const signedMoney = (rupiah: number) =>
  `${rupiah < 0 ? "-" : "+"}${money(Math.abs(rupiah))}`

const signedSweepLots = ({ side, lots: l }: Sweep) => (side === "buy" ? l : -l)

/** Net sweep lots per candle. A wall is never in it: its lots are lower bounds, on the maker's side. */
const netByPeriod = (sweeps: ReadonlyArray<Sweep>, periodMs: number) => {
  const net = new Map<string, number>()
  for (const s of sweeps) {
    const at = periodOf(s.tradedAt, periodMs)
    net.set(at, (net.get(at) ?? 0) + signedSweepLots(s))
  }
  return net
}

export type NetPoint = {
  readonly at: string
  readonly net: number
  readonly cumulative: number
}

/** One point per candle, so the pane lines up with the candles above it. */
export const netPoints = (
  candles: ReadonlyArray<MinuteCandle>,
  sweeps: ReadonlyArray<Sweep>,
  periodMs: number
): ReadonlyArray<NetPoint> => {
  const byPeriod = netByPeriod(sweeps, periodMs)
  let cumulative = 0
  return candles.map(({ at }) => {
    const net = byPeriod.get(at) ?? 0
    cumulative += net
    return { at, net, cumulative }
  })
}

export const cumulativeNet = (sweeps: ReadonlyArray<Sweep>) =>
  sweeps.reduce((sum, s) => sum + signedSweepLots(s), 0)

export type ChartMarker = {
  readonly at: string
  readonly tone: "up" | "down"
  readonly text: string
}

/** Buys and bids below the candle, sells and offers above. Only candles on the chart can carry one. */
export const chartMarkers = (
  candles: ReadonlyArray<MinuteCandle>,
  sweeps: ReadonlyArray<Sweep>,
  walls: ReadonlyArray<Wall>,
  periodMs: number
): ReadonlyArray<ChartMarker> => {
  const shown = new Set<string>(candles.map((c) => c.at))
  const markers: Array<ChartMarker> = []
  for (const [at, net] of netByPeriod(sweeps, periodMs)) {
    if (net === 0 || !shown.has(at)) continue
    markers.push({
      at,
      tone: net > 0 ? "up" : "down",
      text: `${net > 0 ? "Sweep Buy" : "Sweep Sell"} ${signedLots(net)}`,
    })
  }
  for (const wall of walls) {
    const at = periodOf(wall.firstSeen, periodMs)
    if (!shown.has(at)) continue
    markers.push({
      at,
      tone: wall.side === "bid" ? "up" : "down",
      text: wallType(wall),
    })
  }
  return markers.sort((a, b) => a.at.localeCompare(b.at))
}

export type SymbolChip = {
  readonly symbol: Symbol
  readonly net: number | null
}

const CHIPS = 24

const gross = ({ buyValue, sellValue }: LeaderboardEntry) =>
  buyValue + sellValue

/** The biggest by gross value, with the selected symbol always there, even with no sweeps. */
export const symbolChips = (
  leaderboard: ReadonlyArray<LeaderboardEntry>,
  selected: Symbol | null
): ReadonlyArray<SymbolChip> => {
  const top = [...leaderboard]
    .sort((a, b) => gross(b) - gross(a) || a.symbol.localeCompare(b.symbol))
    .map((e) => ({ symbol: e.symbol, net: e.buyValue - e.sellValue }))
  const shown = top.slice(0, CHIPS)
  if (selected === null || shown.some((c) => c.symbol === selected))
    return shown
  const own = top.find((c) => c.symbol === selected)
  return [...shown, own ?? { symbol: selected, net: null }]
}

/** Older than this, a closed sweep or a new wall came from a resume, not the moment. */
const TOAST_WITHIN_MS = 30_000

const recent = (iso: string, nowMs: number) =>
  nowMs - Date.parse(iso) <= TOAST_WITHIN_MS

export const sweepToast = (s: Sweep) =>
  `${s.symbol} ${sweepType(s)} ${lots(s.lots)} lots (${money(s.value)}) at ${priceRange(s)}, ${plain(s.freq)} freq · ${wib(s.tradedAt)}`

export const wallToast = (w: Wall) =>
  `${w.symbol} ${wallType(w)} ≥${lots(w.lotsMatched)} lots at ${plain(w.price)}, ≥${plain(w.hitsSeen)} hits · ${wib(w.lastSeen)}`

/** What deserves a toast between two states: a sweep's close, at its final size, and a wall's announcement. */
export const newToasts = (
  before: { sweeps: ReadonlyArray<Sweep>; walls: ReadonlyArray<Wall> },
  after: { sweeps: ReadonlyArray<Sweep>; walls: ReadonlyArray<Wall> },
  nowMs: number
): ReadonlyArray<string> => {
  const closed = new Set(
    before.sweeps.filter((s) => !s.open).map((s) => s.firstNumber)
  )
  const walls = new Set(before.walls.map((w) => w.firstOrderNumber))
  return [
    ...after.sweeps
      .filter(
        (s) =>
          !s.open && !closed.has(s.firstNumber) && recent(s.updatedAt, nowMs)
      )
      .map(sweepToast),
    ...after.walls
      .filter(
        (w) => !walls.has(w.firstOrderNumber) && recent(w.lastSeen, nowMs)
      )
      .map(wallToast),
  ]
}
