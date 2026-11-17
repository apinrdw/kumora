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
  type Footprint,
  type MarketPhase,
  type RecordedBubbles,
  type RunningTrade,
  type SectorName,
  type StockCode,
  type ViewerDown,
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

// The colour metrics as the URL names them: "delta" is Buy/Sell delta %.
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
  readonly buySellDelta: number
  readonly change: number | undefined
  readonly dayChange: number | undefined
  // None for D while the day waits for a backfill to bring its last price.
  readonly last: number | undefined
  // The size metric's figure: value, volume or frequency.
  readonly size: number
}

// One minute's, one second's or the day's regular-board figures.
interface Sums {
  value: number
  volume: number
  frequency: number
  buyValue: number
  sellValue: number
}

// A minute's or a second's figures, and the last price in it.
interface Row extends Sums {
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
  // Every regular-board minute of the day; its last price is lastPrice's.
  day: Sums
  previousClose: number | undefined
  // Minute start in epoch ms → its copy, of minutes older than the kept
  // ones: the newest with trades the flow knows, and emptied ones after it.
  // Bounded by the day's minutes before the kept ones, about 400: letGo
  // drops every minute older than the newest with trades.
  readonly before: Map<number, LetGo>
  // The minutes a delta carried, emptied ones included: `minutes` holds the
  // candle book's latest copy of each.
  readonly carried: Map<number, Carried>
  // The backfills that came after it traded, without its previous close.
  closeMisses: number
}

// Whether this socket's delta carried a minute since its snapshot or an
// earlier socket's did (MarketFlow's `socketFrom`), and MarketFlow's `heard`
// when the latest one did.
interface Carried {
  by: "this socket" | "an earlier one"
  readonly heard: number
}

// A minute older than the kept ones: its close, none once its last trade
// left it, and MarketFlow's `heard` when the flow took this copy.
interface LetGo {
  readonly close: number | undefined
  readonly heard: number
}

export interface MarketFlow {
  readonly codes: Map<StockCode, CodeFlow>
  // The newest minute any code traded in. It only moves forward: it governs
  // which minutes are kept, not where the windows end (newestTrade).
  newestMinute: number
  // Instants on the Worker's clock, in epoch ms: a viewer message's `at`,
  // a backfill's `settledBefore`.
  // The newest the flow heard of.
  heard: number
  // The newest backfill's: an older copy, as the browser's can be, is left
  // out.
  settledBefore: number
  // The snapshot that started this socket, until a backfill settled past
  // it: an earlier socket may have missed deltas, so until then its minutes
  // stay as it left them.
  socketFrom: number | undefined
  // The newest `heard` of a delta that changed a minute the flow has since
  // let go: a body settled at or before it lacks that change in its day
  // totals, and no carried minute is left to lay over them (takeSettled).
  letGoChanged: number
  // When a candle older than the kept minutes changed, its earlier figures
  // gone, or a code lost its last price with no minute left to take one
  // from (waitForPrice), until a backfill settled past it recounts the day.
  recountFrom: number | undefined
  // The tape's trade numbers already counted → what each added, so a
  // snapshot's tape, which repeats trades a delta brought, counts each once,
  // and a later copy with another side or time replaces it.
  readonly seen: Map<number, Counted>
}

// Minutes a code keeps: the backfill's, the longest window and one before
// it, for its change.
const MINUTES_KEPT = BUBBLE_MINUTES
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

// Decision: what a trade or candle runs (isIndex to newestKey, newestHeld to
// waitForPrice, takeMinute, secondOf to countTrade) stays plain, the applies'
// loops Effects. Dev machine, 900 codes, 100,000 each, plain then an Effect
// each: trades 53, 71 ms (2026-11-16); candles 94, 108 ms, late ones that let
// their minute go 60, 75 ms (2026-11-17). A delta can carry thousands.
const isIndex = (code: StockCode) => INDEX_CODES.includes(code)

const noSums = (): Sums => ({
  value: 0,
  volume: 0,
  frequency: 0,
  buyValue: 0,
  sellValue: 0,
})

const emptyRow = (): Row => ({ ...noSums(), close: 0 })

const codeFlowOf = (flow: MarketFlow, code: StockCode): CodeFlow => {
  const held = flow.codes.get(code)
  if (held !== undefined) return held
  const fresh: CodeFlow = {
    minutes: new Map(),
    seconds: new Map(),
    day: noSums(),
    previousClose: undefined,
    before: new Map(),
    carried: new Map(),
    closeMisses: 0,
  }
  flow.codes.set(code, fresh)
  return fresh
}

const noteMinute = (flow: MarketFlow, minute: number) => {
  if (minute > flow.newestMinute) flow.newestMinute = minute
}

// The newest tape trade counted, in epoch ms.
const newestCounted = (flow: MarketFlow) =>
  Effect.sync(() => {
    let newest: number | undefined
    for (const { time } of flow.seen.values())
      if (newest === undefined || time > newest) newest = time
    return newest
  })

// The day's last regular-board trade the flow still counts, in epoch ms: its
// time when the tape carried it, else the start of the newest minute with
// trades the flow holds, kept or let go (newestHeld, as lastPrice reads).
// Decision: derived from what the flow holds each time it is asked, never
// kept as a field, which went stale whenever a correction or a backfill took
// its trade or minute away. Measured 2026-11-17 on the dev machine
// (bubbles.test.ts, "Recompute", 900 codes): median 0.8 ms without the scan,
// 1.2 ms with it. See apinrdw/kumora#436.
const newestTrade = (flow: MarketFlow) =>
  Effect.gen(function* () {
    let newest = yield* newestCounted(flow)
    for (const code of flow.codes.values()) {
      const held = newestHeld(code)
      if (held !== undefined && (newest === undefined || held.minute > newest))
        newest = held.minute
    }
    return newest
  })

const oldestKept = (flow: MarketFlow) =>
  flow.newestMinute - (MINUTES_KEPT - 1) * MINUTE_MS

// A minute with trades the flow holds of a code, and its close.
interface HeldMinute {
  readonly minute: number
  readonly close: number
}

// The newest minute `code` let go with trades.
const newestLetGo = (code: CodeFlow) => {
  let newest: HeldMinute | undefined
  for (const [minute, { close }] of code.before)
    if (close !== undefined && (newest === undefined || minute > newest.minute))
      newest = { minute, close }
  return newest
}

// `close` as the copy of `minute`, older than the kept ones; none when its
// last trade left it. Minutes before the newest with trades go: a late
// trade that empties that one waits for a backfill anyway (takeMinute).
const letGo = (
  flow: MarketFlow,
  code: CodeFlow,
  minute: number,
  close: number | undefined
) => {
  code.before.set(minute, { close, heard: flow.heard })
  const newest = newestLetGo(code)
  if (newest === undefined) return
  for (const at of code.before.keys())
    if (at < newest.minute) code.before.delete(at)
}

const pruneMinutes = (flow: MarketFlow, code: CodeFlow) => {
  const oldest = oldestKept(flow)
  for (const [minute, row] of code.minutes)
    if (minute < oldest) {
      letGo(flow, code, minute, row.close)
      code.minutes.delete(minute)
    }
  for (const [minute, { heard }] of code.carried)
    if (minute < oldest) {
      flow.letGoChanged = Math.max(flow.letGoChanged, heard)
      code.carried.delete(minute)
    }
}

// `row` into `day` in place of `old`, the same minute's earlier figures;
// none for a minute with no trades.
const NO_ROW: Readonly<Sums> = noSums()
const replaceInDay = (
  day: Sums,
  row: Sums | undefined,
  old: Sums | undefined
) => {
  const now = row ?? NO_ROW
  const was = old ?? NO_ROW
  day.value += now.value - was.value
  day.volume += now.volume - was.volume
  day.frequency += now.frequency - was.frequency
  day.buyValue += now.buyValue - was.buyValue
  day.sellValue += now.sellValue - was.sellValue
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
    newestMinute: 0,
    heard: Number.NEGATIVE_INFINITY,
    settledBefore: Number.NEGATIVE_INFINITY,
    letGoChanged: Number.NEGATIVE_INFINITY,
    socketFrom: undefined,
    recountFrom: undefined,
    seen: new Map(),
  }))

// A body's minute and day tuples as rows.
const bodyRows = (flow: MarketFlow, entry: RecordedBubbles["codes"][number]) =>
  Effect.sync(() => {
    const [value, volume, frequency, buyValue, sellValue] = entry.day
    const day: Sums = { value, volume, frequency, buyValue, sellValue }
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
  })

// The newest minute the flow holds of `code` with trades, kept or let go;
// none when it holds none. Kept minutes are all newer than let-go ones.
const newestHeld = (code: CodeFlow): HeldMinute | undefined => {
  const kept = newestKey(code.minutes, Number.POSITIVE_INFINITY)
  return kept === undefined
    ? newestLetGo(code)
    : { minute: kept, close: code.minutes.get(kept)!.close }
}

// A code's last price: the close of the newest minute the flow holds of it
// with trades, kept or let go (newestHeld); none when it holds none.
// Decision: the newest minute's close, its highest-numbered trade's price
// (candles.ts `fold`), read off the minutes' latest copies, never cached
// past them. A let-go copy stands until a backfill settled past its `heard`
// (applyBubbles). Recompute bench, 900 codes, 2026-11-17: median 1.3 to
// 1.5 ms, before and after. See apinrdw/kumora#436.
export const lastPrice = (code: CodeFlow) => newestHeld(code)?.close

// A day that still has trades and no last price waits for a backfill.
const waitForPrice = (flow: MarketFlow, code: CodeFlow) => {
  if (code.day.frequency > 0 && lastPrice(code) === undefined)
    flow.recountFrom = flow.heard
}

// The minutes deltas carried laid over a body's, the day totals moved by
// what each changes over the body's copy. A body that `takesBack` an
// earlier socket's minutes has every trade they held. A body that holds a
// code's full BUBBLE_MINUTES knows none older than its first: such a minute
// is older than every window, so the body's copy stands, and a change the
// body settled short of waits for a recount.
const keepCarried = (
  flow: MarketFlow,
  code: CodeFlow,
  body: { readonly day: Sums; readonly minutes: Map<number, Row> },
  oldest: number,
  takesBack: boolean
) =>
  Effect.sync(() => {
    for (const [at, { by, heard }] of code.carried) {
      const bodyRow = body.minutes.get(at)
      if (takesBack && by === "an earlier one") {
        code.carried.delete(at)
        continue
      }
      if (bodyRow === undefined && at < oldest) {
        if (heard >= flow.settledBefore) flow.recountFrom = flow.heard
        code.carried.delete(at)
        continue
      }
      const row = code.minutes.get(at)
      // An emptied minute has no settled trade: the body holds none of it.
      if (row !== undefined) body.minutes.set(at, row)
      replaceInDay(body.day, row, bodyRow)
    }
  })

// The minutes `code` let go, against a body settled before `settledBefore`:
// a copy taken since stands over the body's minute, and one taken before
// gives way to it. The body's minutes older than a copy that stands give
// way too: the flow let go newer copies of them (letGo) than the body has.
const keepLetGo = (
  code: CodeFlow,
  bodyMinutes: Map<number, Row>,
  settledBefore: number
) =>
  Effect.sync(() => {
    let standing = Number.NEGATIVE_INFINITY
    for (const [at, held] of code.before)
      if (held.heard < settledBefore) code.before.delete(at)
      else standing = Math.max(standing, at)
    for (const at of bodyMinutes.keys())
      if (at <= standing) bodyMinutes.delete(at)
  })

// A body settled before `settledBefore` taken: whether it takes back an
// earlier socket's minutes.
// Decision: a body holds every trade that reached the Worker before its
// `settledBefore`, the clock the messages' `at` is on. Only one settled past
// this socket's snapshot takes back an earlier socket's minutes, and only
// one past a recount's trigger recounts; one settled short, however early
// it was asked for, leaves both waiting. See apinrdw/kumora#436.
const takeSettled = (flow: MarketFlow, settledBefore: number) =>
  Effect.sync(() => {
    flow.settledBefore = settledBefore
    flow.heard = Math.max(flow.heard, settledBefore)
    if (flow.recountFrom !== undefined && settledBefore > flow.recountFrom)
      flow.recountFrom = undefined
    // A minute changed since and let go has no carried copy to lay over it.
    if (settledBefore <= flow.letGoChanged) flow.recountFrom = flow.heard
    const takesBack =
      flow.socketFrom === undefined || settledBefore > flow.socketFrom
    if (takesBack) flow.socketFrom = undefined
    return takesBack
  })

// Decision: a minute is the candle book's latest copy (candles.ts): a
// delta's candle, or footprint with no cells, replaces it, smaller too. The
// body has only settled trades, which never leave a minute, so it fills the
// minutes no delta carried. See apinrdw/kumora#436 and spec #427,
// "Reconnects".
//
// A code the flow holds that the body doesn't has no settled trade: its
// minutes no delta carried are none.
export const applyBubbles = (flow: MarketFlow, body: RecordedBubbles) =>
  Effect.gen(function* () {
    if (body.settledBefore < flow.settledBefore) return
    const takesBack = yield* takeSettled(flow, body.settledBefore)
    const inBody = new Set(body.codes.map(({ code }) => code))
    const entries = [...body.codes]
    for (const code of flow.codes.keys())
      if (!inBody.has(code))
        entries.push({ code, day: [0, 0, 0, 0, 0], minutes: [] })
    for (const entry of entries) {
      const code = codeFlowOf(flow, entry.code)
      const rows = yield* bodyRows(flow, entry)
      yield* keepCarried(
        flow,
        code,
        rows,
        entry.minutes.length < BUBBLE_MINUTES
          ? Number.NEGATIVE_INFINITY
          : entry.minutes[0]![0],
        takesBack
      )
      yield* keepLetGo(code, rows.minutes, body.settledBefore)
      code.minutes.clear()
      for (const [at, row] of rows.minutes) code.minutes.set(at, row)
      code.day = rows.day
      waitForPrice(flow, code)
      code.previousClose = entry.previousClose ?? code.previousClose
      if (code.previousClose === undefined && code.day.frequency > 0)
        code.closeMisses++
      pruneMinutes(flow, code)
    }
  })

// Whether the flow waits for a backfill: one settled past this socket's
// snapshot or a recount's trigger (MarketFlow's `socketFrom` and
// `recountFrom`), or one that carries the previous close of a code that
// traded today and has none, as one first seen in a delta or the tape, or
// one the body carried before its `liveprice` frame came. Only the backfill
// does any of them.
export const missingFromBackfill = (flow: MarketFlow) =>
  Effect.sync(() => {
    if (flow.socketFrom !== undefined || flow.recountFrom !== undefined)
      return true
    for (const code of flow.codes.values())
      if (
        code.day.frequency > 0 &&
        code.previousClose === undefined &&
        code.closeMisses < CLOSE_MISSES
      )
        return true
    return false
  })

// Decision: a code's previous close is asked for in at most CLOSE_MISSES
// backfills after it traded, then given up on for the day: each ask GETs
// the whole backfill, up to about 3.5 MB, and a code whose `liveprice`
// frame never came would ask once a minute all day. Its day change and
// up / down place stay unknown. FRESH_ASKS (use-market-flow.ts) caps waits.
const CLOSE_MISSES = 3

// `row` as the book's copy of `code`'s minute `at`; none when its last
// trade left it. Plain, per candle (the Decision at isIndex).
const takeMinute = (
  flow: MarketFlow,
  stock: StockCode,
  at: number,
  row: Row | undefined
) => {
  const code = codeFlowOf(flow, stock)
  // Older than any window: a late trade changed it, whose figures only a
  // backfill brings into the day's totals.
  if (at < oldestKept(flow)) {
    pruneMinutes(flow, code)
    letGo(flow, code, at, row?.close)
    flow.recountFrom = flow.heard
    return
  }
  replaceInDay(code.day, row, code.minutes.get(at))
  code.carried.set(at, { by: "this socket", heard: flow.heard })
  if (row === undefined) code.minutes.delete(at)
  else {
    code.minutes.set(at, row)
    noteMinute(flow, at)
  }
  waitForPrice(flow, code)
  pruneMinutes(flow, code)
}

// Each candle replaces its minute. An index's are left out: the map is of
// stock codes.
export const applyCandles = (
  flow: MarketFlow,
  candles: ReadonlyArray<Candle>
) =>
  Effect.sync(() => {
    for (const candle of candles)
      if (!isIndex(candle.code))
        takeMinute(flow, candle.code, DateTime.toEpochMillis(candle.minute), {
          value: candle.value,
          volume: candle.volume,
          frequency: candle.frequency,
          buyValue: candle.buyValue,
          sellValue: candle.sellValue,
          close: candle.close,
        })
  })

// A footprint with no cells drops its minute: its last regular-board trade
// left it, and the book sends it so for every code (candles.ts,
// `takeChanged`).
const applyEmptied = (flow: MarketFlow, footprints: ReadonlyArray<Footprint>) =>
  Effect.sync(() => {
    for (const footprint of footprints)
      if (footprint.cells.length === 0 && !isIndex(footprint.code))
        takeMinute(
          flow,
          footprint.code,
          DateTime.toEpochMillis(footprint.minute),
          undefined
        )
  })

// A snapshot sent at `sentAt` starts a socket, which may have missed
// deltas: the minutes the deltas before it carried go back to the first
// body settled past it. A snapshot that answers a Select on the same socket
// looks the same, and waits for that body too.
const startSocket = (flow: MarketFlow, sentAt: number) =>
  Effect.sync(() => {
    flow.socketFrom = sentAt
    for (const code of flow.codes.values())
      for (const carried of code.carried.values()) carried.by = "an earlier one"
  })

// A tape trade as its second's row counts it.
interface Counted {
  readonly code: StockCode
  // The trade's time in epoch ms, and its second's start.
  readonly time: number
  readonly second: number
  readonly price: number
  readonly lots: number
  readonly side: RunningTrade["side"]
}

// `code`'s row of `second`, made when it has none, letting older ones go.
// Plain, per trade (the Decision at isIndex).
const secondOf = (code: CodeFlow, second: number) => {
  const held = code.seconds.get(second)
  if (held !== undefined) return held
  const row: SecondRow = { ...emptyRow(), order: -1 }
  code.seconds.set(second, row)
  for (const at of code.seconds.keys())
    if (at < second - SECONDS_KEPT_MS) code.seconds.delete(at)
  return row
}

const sameCount = (a: Counted, b: Counted) =>
  a.time === b.time &&
  a.price === b.price &&
  a.lots === b.lots &&
  a.side === b.side

// Takes `counted`, trade `number`'s earlier copy, out of its second. A second
// it closed closes at its newest other trade still counted.
const removeTrade = (flow: MarketFlow, number: number, counted: Counted) => {
  flow.seen.delete(number)
  const code = flow.codes.get(counted.code)
  const row = code?.seconds.get(counted.second)
  if (code === undefined || row === undefined) return
  const value = counted.price * counted.lots * SHARES_PER_LOT
  row.value -= value
  row.volume -= counted.lots
  row.frequency -= 1
  if (counted.side === "buy") row.buyValue -= value
  if (counted.side === "sell") row.sellValue -= value
  if (row.frequency === 0) {
    code.seconds.delete(counted.second)
    return
  }
  if (row.order !== number) return
  row.order = -1
  for (const [other, held] of flow.seen)
    if (
      other > row.order &&
      held.code === counted.code &&
      held.second === counted.second
    ) {
      row.order = other
      row.close = held.price
    }
}

const addTrade = (flow: MarketFlow, number: number, counted: Counted) => {
  flow.seen.set(number, counted)
  const row = secondOf(codeFlowOf(flow, counted.code), counted.second)
  const value = counted.price * counted.lots * SHARES_PER_LOT
  row.value += value
  row.volume += counted.lots
  row.frequency += 1
  if (counted.side === "buy") row.buyValue += value
  if (counted.side === "sell") row.sellValue += value
  if (number > row.order) {
    row.order = number
    row.close = counted.price
  }
}

// A copy of a trade: one off the regular board takes out what an earlier
// copy of its number counted, and counts nothing.
const countTrade = (flow: MarketFlow, trade: RunningTrade) => {
  const number = Number(trade.tradeNumber)
  const time = DateTime.toEpochMillis(trade.time)
  const counted: Counted = {
    code: trade.code,
    time,
    second: Math.floor(time / SECOND_MS) * SECOND_MS,
    price: trade.price,
    lots: trade.lots,
    side: trade.side,
  }
  const regular = trade.board === "RG"
  const held = flow.seen.get(number)
  if (held !== undefined) {
    if (regular && sameCount(held, counted)) return
    removeTrade(flow, number, held)
  }
  if (regular) addTrade(flow, number, counted)
}

// The tape's regular-board trades into their seconds, each trade once: a
// repeated trade number whose copy differs, as when Stockbit's copy settles
// the side, time or board of Ajaib's, replaces the first, before the board
// is filtered.
export const applyTrades = (
  flow: MarketFlow,
  trades: ReadonlyArray<RunningTrade>
) =>
  Effect.gen(function* () {
    for (const trade of trades)
      if (!isIndex(trade.code)) countTrade(flow, trade)
    // Insertion order is about time order: drop from the front.
    const newest = (yield* newestCounted(flow)) ?? 0
    for (const [number, { second }] of flow.seen) {
      if (second >= newest - SECONDS_KEPT_MS) break
      flow.seen.delete(number)
    }
  })

// A viewer message into the flow: its tape, and a delta's candles and
// emptied minutes.
export const applyMessage = (flow: MarketFlow, message: ViewerDown) =>
  Effect.gen(function* () {
    const at = DateTime.toEpochMillis(message.at)
    flow.heard = Math.max(flow.heard, at)
    if (message._tag === "Snapshot") yield* startSocket(flow, at)
    yield* applyTrades(flow, message.tape)
    if (message._tag === "Snapshot") return
    yield* applyCandles(flow, message.candles)
    yield* applyEmptied(flow, message.footprints ?? [])
  })

// Where the windows end, and whether the session is closed: now during a
// session, else the day's last trade. None before the day's first trade.
export const windowEnd = (flow: MarketFlow, phase: MarketPhase, now: number) =>
  Effect.gen(function* () {
    const last = yield* newestTrade(flow)
    if (last === undefined) return undefined
    return SESSIONS.has(phase)
      ? { end: now, closed: false }
      : { end: last, closed: true }
  })

const sum = (into: Sums, row: Sums) => {
  into.value += row.value
  into.volume += row.volume
  into.frequency += row.frequency
  into.buyValue += row.buyValue
  into.sellValue += row.sellValue
}

const percent = (from: number | undefined, to: number | undefined) =>
  from === undefined || from === 0 || to === undefined
    ? undefined
    : ((to - from) / from) * 100

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

// The price before the minutes `code` keeps: the previous close when it let
// none go, else the newest let go with trades; none when that one emptied.
const closeBeforeKept = (code: CodeFlow) =>
  code.before.size === 0 ? code.previousClose : newestLetGo(code)?.close

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
  end: number,
  dayLast: number | undefined
): { row: Sums; close: number | undefined; before: number | undefined } => {
  if (window === "D")
    return { row: code.day, close: dayLast, before: code.previousClose }
  if (window === "30s") {
    const last = Math.floor(end / SECOND_MS) * SECOND_MS
    const first = last - 29 * SECOND_MS
    const { row, before } = gather(code.seconds, first, last)
    return {
      row,
      close: row.close,
      before: priceBefore30s(code, before, first),
    }
  }
  const last = Math.floor(end / MINUTE_MS) * MINUTE_MS
  const first = last - (WINDOW_MINUTES[window] - 1) * MINUTE_MS
  const { row, before } = gather(code.minutes, first, last)
  return {
    row,
    close: row.close,
    before: before?.close ?? closeBeforeKept(code),
  }
}

const SIZE_OF: Record<SizeMetric, (row: Sums) => number> = {
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
      const dayLast = lastPrice(held)
      const { row, close, before } = windowFigures(
        held,
        view.window,
        end,
        dayLast
      )
      if (row.frequency === 0) continue
      const sides = row.buyValue + row.sellValue
      shown.push({
        code,
        value: row.value,
        volume: row.volume,
        frequency: row.frequency,
        buyValue: row.buyValue,
        sellValue: row.sellValue,
        buySellDelta:
          sides === 0 ? 0 : ((row.buyValue - row.sellValue) / sides) * 100,
        change: percent(before, close),
        dayChange: percent(held.previousClose, dayLast),
        last: close,
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
    if (view.colour === "delta") return bubble.buySellDelta / 100
    if (bubble.change === undefined) return undefined
    return Math.max(-1, Math.min(1, bubble.change / CHANGE_RANGE[view.window]))
  })

// Share of the canvas the bubbles' area fills.
const FILL = 0.34

// The radius scale: a bubble's radius is k·√size, so the bubbles of `sizes`
// fill FILL of a `width` × `height` canvas (px), but no smaller than the
// floor, which is smaller when more than 300 are shown. One code far larger
// than the rest on a short canvas would outgrow it: the largest bubble's
// diameter is at most the height. A canvas with no room, as a hidden tab's,
// scales every bubble to nothing.
export const bubbleScale = (
  sizes: ReadonlyArray<number>,
  width: number,
  height: number
) =>
  Effect.sync(() => {
    let total = 0
    let largest = 0
    for (const size of sizes) {
      total += size
      largest = Math.max(largest, size)
    }
    if (total <= 0 || width <= 0 || height <= 0)
      return { k: 0, minRadius: sizes.length > 300 ? 4 : 7 }
    const filling = Math.sqrt((FILL * width * height) / (Math.PI * total))
    return {
      k: Math.min(filling, height / 2 / Math.sqrt(largest)),
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

const scaled = (n: number, steps: ReadonlyArray<readonly [number, string]>) =>
  Effect.sync(() => {
    for (const [at, suffix] of steps)
      if (n >= at) return `${twoDigits.format(n / at)} ${suffix}`
    return whole.format(n)
  })

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
  Effect.gen(function* () {
    if (metric === "value") return `Rp${yield* scaled(n, RUPIAH_STEPS)}`
    return `${yield* scaled(n, COUNT_STEPS)} ${metric === "volume" ? "lots" : "trades"}`
  })
