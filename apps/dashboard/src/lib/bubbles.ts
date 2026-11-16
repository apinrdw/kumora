// Market Bubbles' figures (spec apinrdw/kumora#427, "Windows, figures and
// ranking"): every stock code's value, volume, frequency, Buy/Sell delta % and
// price change % over a window, from the bubbles backfill, the deltas'
// candles and the tape. The page keeps one MarketFlow and asks it for the
// bubbles each second.
import {
  BUBBLE_MINUTES,
  INDEX_CODES,
  MINUTE_MS,
  SHARES_PER_LOT,
  type Candle,
  type MarketPhase,
  type RecordedBubbles,
  type RunningTrade,
  type SectorName,
  type StockCode,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

export const BUBBLE_WINDOWS = [
  "30s",
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "D",
] as const
export type BubbleWindow = (typeof BUBBLE_WINDOWS)[number]

export const SIZE_METRICS = ["value", "volume", "freq"] as const
export type SizeMetric = (typeof SIZE_METRICS)[number]

export const COLOUR_METRICS = ["delta", "change"] as const
export type ColourMetric = (typeof COLOUR_METRICS)[number]

export const TOP_NS = [100, 50, "all"] as const
export type TopN = (typeof TOP_NS)[number]

export interface BubbleView {
  readonly size: SizeMetric
  readonly colour: ColourMetric
  readonly window: BubbleWindow
  readonly top: TopN
  // One sector's codes, or every sector's when none.
  readonly sector?: SectorName | undefined
}

// One code's figures over a window. Change is against the price before the
// window; none when that price isn't known. Day change is against the
// previous close.
export interface BubbleFigures {
  readonly code: StockCode
  readonly value: number
  readonly volume: number
  readonly frequency: number
  readonly buyValue: number
  readonly sellValue: number
  readonly delta: number
  readonly change: number | undefined
  readonly dayChange: number | undefined
  readonly last: number
  // The size metric's figure: value, volume or frequency.
  readonly size: number
}

// One minute's, one second's or the day's regular-board figures, and the last
// price in it.
interface Row {
  value: number
  volume: number
  frequency: number
  buyValue: number
  sellValue: number
  close: number
}

// A second's figures; `order` is the trade number of the trade its close is.
interface SecondRow extends Row {
  order: number
}

interface CodeFlow {
  // Minute start in epoch ms → its candle's figures; the newest
  // MINUTES_KEPT minutes of the market's.
  readonly minutes: Map<number, Row>
  // Second start in epoch ms → its tape trades' figures, for 30s.
  readonly seconds: Map<number, SecondRow>
  // Every regular-board minute of the day; `close` is the last price.
  day: Row
  previousClose: number | undefined
  // The close of the newest minute let go from `minutes`: the price before
  // any window when the code traded in none of the minutes kept before it.
  closeBefore: { minute: number; close: number } | undefined
  // Whether a backfill carried the code, and with it its previous close.
  backfilled: boolean
}

export interface MarketFlow {
  readonly codes: Map<StockCode, CodeFlow>
  // The day's last regular-board trade, in epoch ms: its time when the tape
  // carried it, else its minute's start.
  lastTrade: number | undefined
  // The newest minute any code traded in.
  newestMinute: number
  // The tape's trade numbers already counted → their second, so a snapshot's
  // tape, which repeats trades a delta brought, counts each once.
  readonly seen: Map<number, number>
}

// Minutes a code keeps: one before the longest window, for its change.
const MINUTES_KEPT = BUBBLE_MINUTES + 1
const SECOND_MS = 1000
// Seconds a code keeps: 30s and the seconds before it, for its change.
const SECONDS_KEPT_MS = 90_000

const WINDOW_MINUTES: Record<Exclude<BubbleWindow, "30s" | "D">, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
}

// The phases whose windows end now; any other ends at the day's last trade.
const SESSIONS: ReadonlySet<MarketPhase> = new Set(["session-1", "session-2"])

const isIndex = (code: StockCode) => INDEX_CODES.includes(code)

const emptyRow = (): Row => ({
  value: 0,
  volume: 0,
  frequency: 0,
  buyValue: 0,
  sellValue: 0,
  close: 0,
})

const codeFlowOf = (flow: MarketFlow, code: StockCode): CodeFlow => {
  const held = flow.codes.get(code)
  if (held !== undefined) return held
  const fresh: CodeFlow = {
    minutes: new Map(),
    seconds: new Map(),
    day: emptyRow(),
    previousClose: undefined,
    closeBefore: undefined,
    backfilled: false,
  }
  flow.codes.set(code, fresh)
  return fresh
}

const noteMinute = (flow: MarketFlow, minute: number) => {
  if (minute > flow.newestMinute) flow.newestMinute = minute
  if (flow.lastTrade === undefined || minute > flow.lastTrade)
    flow.lastTrade = minute
}

const oldestKept = (flow: MarketFlow) =>
  flow.newestMinute - (MINUTES_KEPT - 1) * MINUTE_MS

// `close`, of a minute older than any window, as the code's price before
// them when it is the newest such minute yet.
const noteBefore = (code: CodeFlow, minute: number, close: number) => {
  if (code.closeBefore === undefined || minute >= code.closeBefore.minute)
    code.closeBefore = { minute, close }
}

const pruneMinutes = (flow: MarketFlow, code: CodeFlow) => {
  const oldest = oldestKept(flow)
  for (const [minute, row] of code.minutes)
    if (minute < oldest) {
      noteBefore(code, minute, row.close)
      code.minutes.delete(minute)
    }
}

// `row` into `day` in place of `old`, the same minute's earlier figures.
const replaceInDay = (day: Row, row: Row, old: Row | undefined) => {
  day.value += row.value - (old?.value ?? 0)
  day.volume += row.volume - (old?.volume ?? 0)
  day.frequency += row.frequency - (old?.frequency ?? 0)
  day.buyValue += row.buyValue - (old?.buyValue ?? 0)
  day.sellValue += row.sellValue - (old?.sellValue ?? 0)
}

const newestKey = (rows: ReadonlyMap<number, Row>, atOrBefore: number) => {
  let newest: number | undefined
  for (const key of rows.keys())
    if (key <= atOrBefore && (newest === undefined || key > newest))
      newest = key
  return newest
}

export const makeMarketFlow = () =>
  Effect.sync((): MarketFlow => ({
    codes: new Map(),
    lastTrade: undefined,
    newestMinute: 0,
    seen: new Map(),
  }))

// A body's minute and day tuples as rows.
const bodyRows = (
  flow: MarketFlow,
  entry: RecordedBubbles["codes"][number]
) => {
  const [value, volume, frequency, buyValue, sellValue, close] = entry.day
  const day: Row = { value, volume, frequency, buyValue, sellValue, close }
  const minutes = new Map<number, Row>()
  for (const [at, v, vol, freq, buy, sell, last] of entry.minutes) {
    minutes.set(at, {
      value: v,
      volume: vol,
      frequency: freq,
      buyValue: buy,
      sellValue: sell,
      close: last,
    })
    noteMinute(flow, at)
  }
  return { day, minutes }
}

// The minutes `code` holds laid over a body's: each keeps the copy with
// more trades. The day totals are the body's, plus what each kept held
// minute adds over the body's copy; a minute older than the body's `oldest`
// is already whole in the body's totals.
const keepHeld = (
  code: CodeFlow,
  body: { readonly day: Row; readonly minutes: Map<number, Row> },
  oldest: number
) => {
  for (const [at, row] of code.minutes) {
    const bodyRow = body.minutes.get(at)
    if (bodyRow !== undefined && bodyRow.frequency >= row.frequency) continue
    body.minutes.set(at, row)
    if (at >= oldest || bodyRow !== undefined)
      replaceInDay(body.day, row, bodyRow)
  }
}

// Decision: a minute keeps whichever of its copies has more trades, the
// body's or a delta's candle. The body is built from settled trades once a
// minute and the browser may answer an older copy, so a delta that came
// before it can hold more of the minute; a candle only grows.
export const applyBubbles = (flow: MarketFlow, body: RecordedBubbles) =>
  Effect.sync(() => {
    for (const entry of body.codes) {
      const code = codeFlowOf(flow, entry.code)
      const rows = bodyRows(flow, entry)
      keepHeld(code, rows, entry.minutes[0]?.[0] ?? Number.POSITIVE_INFINITY)
      code.minutes.clear()
      for (const [at, row] of rows.minutes) code.minutes.set(at, row)
      const newest = newestKey(code.minutes, Number.POSITIVE_INFINITY)
      if (newest !== undefined) rows.day.close = code.minutes.get(newest)!.close
      code.day = rows.day
      code.previousClose = entry.previousClose ?? code.previousClose
      code.backfilled = true
      pruneMinutes(flow, code)
    }
  })

// Whether a code first seen in a delta or the tape waits for a backfill to
// carry its previous close: only the backfill does.
export const missingFromBackfill = (flow: MarketFlow) =>
  Effect.sync(() => {
    for (const code of flow.codes.values()) if (!code.backfilled) return true
    return false
  })

// Each candle replaces its minute, unless the copy held has more trades. An
// index's are left out: the map is of stock codes.
export const applyCandles = (
  flow: MarketFlow,
  candles: ReadonlyArray<Candle>
) =>
  Effect.sync(() => {
    for (const candle of candles) {
      if (isIndex(candle.code)) continue
      const at = DateTime.toEpochMillis(candle.minute)
      const code = codeFlowOf(flow, candle.code)
      // Older than any window: its trades are already in the day's totals.
      if (at < oldestKept(flow)) {
        noteBefore(code, at, candle.close)
        continue
      }
      const old = code.minutes.get(at)
      if (old !== undefined && old.frequency > candle.frequency) continue
      const row: Row = {
        value: candle.value,
        volume: candle.volume,
        frequency: candle.frequency,
        buyValue: candle.buyValue,
        sellValue: candle.sellValue,
        close: candle.close,
      }
      replaceInDay(code.day, row, old)
      code.minutes.set(at, row)
      noteMinute(flow, at)
      if (newestKey(code.minutes, Number.POSITIVE_INFINITY) === at)
        code.day.close = candle.close
      pruneMinutes(flow, code)
    }
  })

// `code`'s row of `second`, made when it has none, letting older ones go.
const secondOf = (code: CodeFlow, second: number) => {
  const held = code.seconds.get(second)
  if (held !== undefined) return held
  const row: SecondRow = { ...emptyRow(), order: -1 }
  code.seconds.set(second, row)
  for (const at of code.seconds.keys())
    if (at < second - SECONDS_KEPT_MS) code.seconds.delete(at)
  return row
}

const addTrade = (flow: MarketFlow, trade: RunningTrade, number: number) => {
  const time = DateTime.toEpochMillis(trade.time)
  const second = Math.floor(time / SECOND_MS) * SECOND_MS
  flow.seen.set(number, second)
  if (flow.lastTrade === undefined || time > flow.lastTrade)
    flow.lastTrade = time
  const row = secondOf(codeFlowOf(flow, trade.code), second)
  const value = trade.price * trade.lots * SHARES_PER_LOT
  row.value += value
  row.volume += trade.lots
  row.frequency += 1
  if (trade.side === "buy") row.buyValue += value
  if (trade.side === "sell") row.sellValue += value
  if (number > row.order) {
    row.order = number
    row.close = trade.price
  }
}

// The tape's regular-board trades into their seconds, each trade once.
export const applyTrades = (
  flow: MarketFlow,
  trades: ReadonlyArray<RunningTrade>
) =>
  Effect.sync(() => {
    for (const trade of trades) {
      if (trade.board !== "RG" || isIndex(trade.code)) continue
      const number = Number(trade.tradeNumber)
      if (!flow.seen.has(number)) addTrade(flow, trade, number)
    }
    // Insertion order is about time order: drop from the front.
    const newest = flow.lastTrade ?? 0
    for (const [number, second] of flow.seen) {
      if (second >= newest - SECONDS_KEPT_MS) break
      flow.seen.delete(number)
    }
  })

// Where the windows end, and whether the session is closed: now during a
// session, else the day's last trade. None before the day's first trade.
export const windowEnd = (flow: MarketFlow, phase: MarketPhase, now: number) =>
  Effect.sync(() => {
    if (flow.lastTrade === undefined) return undefined
    return SESSIONS.has(phase)
      ? { end: now, closed: false }
      : { end: flow.lastTrade, closed: true }
  })

const sum = (into: Row, row: Row) => {
  into.value += row.value
  into.volume += row.volume
  into.frequency += row.frequency
  into.buyValue += row.buyValue
  into.sellValue += row.sellValue
}

const percent = (from: number | undefined, to: number) =>
  from === undefined || from === 0 ? undefined : ((to - from) / from) * 100

// The rows keyed `first` to `last` summed, `close` the newest one's, and
// the newest row before `first`.
const gather = (
  rows: ReadonlyMap<number, Row>,
  first: number,
  last: number
): { row: Row; before: Row | undefined } => {
  const row = emptyRow()
  let newest = -1
  let before = -1
  for (const [at, held] of rows) {
    if (at > last) continue
    if (at < first) {
      before = Math.max(before, at)
      continue
    }
    sum(row, held)
    if (at > newest) {
      newest = at
      row.close = held.close
    }
  }
  return { row, before: before < 0 ? undefined : rows.get(before) }
}

// The price before the minutes `code` keeps: its last close let go, else the
// previous close.
const closeBeforeKept = (code: CodeFlow) =>
  code.closeBefore?.close ?? code.previousClose

// The price before a 30s window from `first`: its code's last second before
// it, else the last minute whole before it, else the previous close.
const priceBefore30s = (
  code: CodeFlow,
  before: Row | undefined,
  first: number
) => {
  if (before !== undefined) return before.close
  const minute = newestKey(code.minutes, first - MINUTE_MS)
  return minute === undefined
    ? closeBeforeKept(code)
    : code.minutes.get(minute)!.close
}

// Decision: a code's window figures are plain functions, not Effects: the
// page asks for every code's each second, and the spec holds that under 2 ms
// for 900 codes. Measured 2026-11-16 on the dev machine (bubbles.test.ts,
// "Recompute"): median 1.0 ms plain, 1.23 ms with an Effect per code. The
// Effect around the loop stays (bubblesOf), and so do the applies'.
const windowFigures = (
  code: CodeFlow,
  window: BubbleWindow,
  end: number
): { row: Row; before: number | undefined } => {
  if (window === "D") return { row: code.day, before: code.previousClose }
  if (window === "30s") {
    const last = Math.floor(end / SECOND_MS) * SECOND_MS
    const first = last - 29 * SECOND_MS
    const { row, before } = gather(code.seconds, first, last)
    return { row, before: priceBefore30s(code, before, first) }
  }
  const last = Math.floor(end / MINUTE_MS) * MINUTE_MS
  const first = last - (WINDOW_MINUTES[window] - 1) * MINUTE_MS
  const { row, before } = gather(code.minutes, first, last)
  return { row, before: before?.close ?? closeBeforeKept(code) }
}

const SIZE_OF: Record<SizeMetric, (row: Row) => number> = {
  value: (row) => row.value,
  volume: (row) => row.volume,
  freq: (row) => row.frequency,
}

// The codes with a regular-board trade in the window ending at `end`,
// largest first by the size metric, the top N of them.
export const bubblesOf = (flow: MarketFlow, view: BubbleView, end: number) =>
  Effect.sync(() => {
    const size = SIZE_OF[view.size]
    const shown: Array<BubbleFigures> = []
    for (const [code, held] of flow.codes) {
      const { row, before } = windowFigures(held, view.window, end)
      if (row.frequency === 0) continue
      const sides = row.buyValue + row.sellValue
      shown.push({
        code,
        value: row.value,
        volume: row.volume,
        frequency: row.frequency,
        buyValue: row.buyValue,
        sellValue: row.sellValue,
        delta: sides === 0 ? 0 : ((row.buyValue - row.sellValue) / sides) * 100,
        change: percent(before, row.close),
        dayChange: percent(held.previousClose, held.day.close),
        last: row.close,
        size: size(row),
      })
    }
    shown.sort((a, b) => b.size - a.size)
    return view.top === "all" ? shown : shown.slice(0, view.top)
  })

// How far a price change % reaches full colour, per window.
const CHANGE_RANGE: Record<BubbleWindow, number> = {
  "30s": 0.6,
  "1m": 1,
  "5m": 2,
  "15m": 3,
  "30m": 4,
  "1h": 5,
  D: 8,
}

// A bubble's colour, -1 (all sell, or falling) to 1 (all buy, or rising);
// none for a change with no price to compare, which colours grey.
export const bubbleTone = (bubble: BubbleFigures, view: BubbleView) =>
  Effect.sync(() => {
    if (view.colour === "delta") return bubble.delta / 100
    if (bubble.change === undefined) return undefined
    return Math.max(-1, Math.min(1, bubble.change / CHANGE_RANGE[view.window]))
  })

// Share of the canvas the bubbles' area fills.
const FILL = 0.34

// The radius scale: a bubble's radius is k·√size, so the bubbles of `sizes`
// fill FILL of `area` (px²), but no smaller than the floor, which is smaller
// when more than 300 are shown.
export const bubbleScale = (sizes: ReadonlyArray<number>, area: number) =>
  Effect.sync(() => {
    let total = 0
    for (const size of sizes) total += size
    return {
      k: total > 0 ? Math.sqrt((FILL * area) / (Math.PI * total)) : 0,
      minRadius: sizes.length > 300 ? 4 : 7,
    }
  })

// The radius from which a bubble writes each line: its code, then its
// metric %, then its size figure; and from which it draws its company's logo
// above the code.
export const LABEL_RADII = {
  code: 11,
  metric: 17,
  figure: 26,
  logo: 26,
} as const

const twoDigits = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

const scaled = (n: number, steps: ReadonlyArray<readonly [number, string]>) => {
  for (const [at, suffix] of steps)
    if (n >= at) return `${twoDigits.format(n / at)} ${suffix}`
  return whole.format(n)
}

const RUPIAH_STEPS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
] as const
const COUNT_STEPS = [
  [1e6, "M"],
  [1e3, "K"],
] as const

// A bubble's size figure: Rp2.35 B, 12.50 K lots, 2.10 M trades.
export const sizeFigure = (metric: SizeMetric, n: number) =>
  Effect.sync(() => {
    if (metric === "value") return `Rp${scaled(n, RUPIAH_STEPS)}`
    return `${scaled(n, COUNT_STEPS)} ${metric === "volume" ? "lots" : "trades"}`
  })
