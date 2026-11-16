// Market Bubbles' figures under the feed's corrections: random runs of
// trades that Stockbit's copies retime across a minute, re-side or move off
// the regular board, against a model of the candle book (candles.ts), whose
// latest copy of a minute is the authority. After each delta, body and
// reconnect, the page's figures equal a recompute from the trades' final
// parts.
import { describe, expect, it } from "@effect/vitest"
import {
  BUBBLE_MINUTES,
  MINUTE_MS,
  SHARES_PER_LOT,
  StockCode,
  TradeNumber,
  type Candle,
  type Footprint,
  type RecordedBubbles,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  applyBubbles,
  applyCandles,
  applyMessage,
  bubblesOf,
  makeMarketFlow,
  missingFromBackfill,
  type BubbleView,
  type MarketFlow,
} from "@/lib/bubbles"
import { marketStrip } from "@/lib/market-strip"

// 10:00:00 WIB on a trading day.
const T0 = Date.parse("2026-11-16T03:00:00Z")
const CODES = [StockCode.make("AAAA"), StockCode.make("BBBB")]
const MINUTES = 4
const END = T0 + MINUTES * MINUTE_MS - 1

// mulberry32: the same runs each time.
const random = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

// A trade as the book holds it: its latest copy, and the copy its candle
// counts, which follows the latest only while the merge window is open.
interface Held {
  copy: RunningTrade
  part: RunningTrade
  open: boolean
}

const minuteOf = (trade: RunningTrade) =>
  Math.floor(DateTime.toEpochMillis(trade.time) / MINUTE_MS) * MINUTE_MS

interface Sums {
  value: number
  volume: number
  frequency: number
  buyValue: number
  sellValue: number
  close: number
  order: number
}

const sumsOf = (trades: Iterable<RunningTrade>) => {
  const sums: Sums = {
    value: 0,
    volume: 0,
    frequency: 0,
    buyValue: 0,
    sellValue: 0,
    close: 0,
    order: -1,
  }
  for (const trade of trades) {
    if (trade.board !== "RG") continue
    const value = trade.price * trade.lots * SHARES_PER_LOT
    sums.value += value
    sums.volume += trade.lots
    sums.frequency += 1
    if (trade.side === "buy") sums.buyValue += value
    if (trade.side === "sell") sums.sellValue += value
    const order = Number(trade.tradeNumber)
    if (order > sums.order) {
      sums.order = order
      sums.close = trade.price
    }
  }
  return sums
}

const inMinute = (
  trades: Iterable<RunningTrade>,
  code: StockCode,
  minute: number
) =>
  [...trades].filter(
    (trade) => trade.code === code && minuteOf(trade) === minute
  )

// The candle book, the backfill and the viewer socket of one day.
const makeServer = (next: () => number) => {
  const trades = new Map<number, Held>()
  // Since the last delta: the trades whose copy changed, and the minutes
  // whose candle did.
  let tape = new Map<number, RunningTrade>()
  let changed = new Set<string>()
  let number = 1

  const parts = () =>
    [...trades.values()].flatMap((held) =>
      held.part.board === "RG" ? [held.part] : []
    )
  const touch = (trade: RunningTrade) => {
    if (trade.board === "RG") changed.add(`${trade.code} ${minuteOf(trade)}`)
  }
  const pick = <A>(from: ReadonlyArray<A>) =>
    from[Math.floor(next() * from.length)]!

  const newTrade = () => {
    const trade: RunningTrade = {
      tradeNumber: TradeNumber.make(String(number++)),
      time: DateTime.makeUnsafe(T0 + Math.floor(next() * MINUTES * MINUTE_MS)),
      code: pick(CODES),
      price: 100 + Math.floor(next() * 5),
      lots: 1 + Math.floor(next() * 4),
      side: pick(["buy", "sell", "none"] as const),
      board: next() < 0.85 ? "RG" : "TN",
      feeds: ["Ajaib"],
    }
    trades.set(Number(trade.tradeNumber), {
      copy: trade,
      part: trade,
      open: true,
    })
    tape.set(Number(trade.tradeNumber), trade)
    touch(trade)
  }

  // Stockbit's copy: another time up to 1.5 s away (across a minute when
  // near one), another side, or another board.
  const correct = () => {
    if (trades.size === 0) return
    const held = pick([...trades.values()])
    const at = DateTime.toEpochMillis(held.copy.time)
    const kind = next()
    const copy: RunningTrade = {
      ...held.copy,
      feeds: ["Ajaib", "Stockbit"],
      ...(kind < 0.4
        ? {
            time: DateTime.makeUnsafe(
              Math.min(
                END,
                Math.max(T0, at + Math.floor((next() - 0.5) * 3_000))
              )
            ),
          }
        : kind < 0.7
          ? { side: pick(["buy", "sell", "none"] as const) }
          : { board: held.copy.board === "RG" ? "TN" : "RG" }),
    }
    held.copy = copy
    tape.set(Number(copy.tradeNumber), copy)
    if (!held.open) return
    touch(held.part)
    held.part = copy
    touch(copy)
  }

  const settle = (all: boolean) => {
    for (const held of trades.values())
      if (all || next() < 0.5) held.open = false
  }

  const candleOf = (code: StockCode, minute: number): Candle | undefined => {
    const sums = sumsOf(inMinute(parts(), code, minute))
    if (sums.frequency === 0) return undefined
    return {
      code,
      minute: DateTime.makeUnsafe(minute),
      open: sums.close,
      high: sums.close,
      low: sums.close,
      close: sums.close,
      volume: sums.volume,
      value: sums.value,
      buyValue: sums.buyValue,
      sellValue: sums.sellValue,
      frequency: sums.frequency,
    }
  }

  const delta = (): ViewerDown => {
    const candles: Array<Candle> = []
    const footprints: Array<Footprint> = []
    for (const key of changed) {
      const [code, minute] = key.split(" ")
      const candle = candleOf(StockCode.make(code!), Number(minute))
      if (candle !== undefined) candles.push(candle)
      // A minute its last regular-board trade left: a footprint with no
      // cells, and no candle.
      else
        footprints.push({
          code: StockCode.make(code!),
          minute: DateTime.makeUnsafe(Number(minute)),
          cells: [],
        })
    }
    const sent: ViewerDown = {
      _tag: "Delta",
      tape: [...tape.values()].sort(
        (a, b) => Number(a.tradeNumber) - Number(b.tradeNumber)
      ),
      candles,
      ...(footprints.length > 0 ? { footprints } : {}),
    }
    tape = new Map()
    changed = new Set()
    return sent
  }

  const snapshot = (): ViewerDown => {
    tape = new Map()
    changed = new Set()
    return {
      _tag: "Snapshot",
      selected: StockCode.make("IHSG"),
      tape: [...trades.values()]
        .map((held) => held.copy)
        .sort((a, b) => Number(a.tradeNumber) - Number(b.tradeNumber)),
      candles: [],
      footprints: [],
      conditions: {
        phase: "session-1",
        relayOnline: true,
        feeds: { Stockbit: "live", Ajaib: "live" },
        gaps: [],
      },
    }
  }

  // The backfill: the settled parts only.
  const body = (): RecordedBubbles => {
    const settled = [...trades.values()].flatMap((held) =>
      held.open || held.part.board !== "RG" ? [] : [held.part]
    )
    const codes: Array<RecordedBubbles["codes"][number]> = []
    for (const code of CODES) {
      const minutes: Array<
        RecordedBubbles["codes"][number]["minutes"][number]
      > = []
      for (let m = 0; m < MINUTES; m++) {
        const minute = T0 + m * MINUTE_MS
        const sums = sumsOf(inMinute(settled, code, minute))
        if (sums.frequency > 0)
          minutes.push([
            minute,
            sums.value,
            sums.volume,
            sums.frequency,
            sums.buyValue,
            sums.sellValue,
            sums.close,
          ])
      }
      if (minutes.length === 0) continue
      const day = sumsOf(settled.filter((trade) => trade.code === code))
      codes.push({
        code,
        previousClose: 100,
        day: [
          day.value,
          day.volume,
          day.frequency,
          day.buyValue,
          day.sellValue,
          day.close,
        ],
        minutes,
      })
    }
    return { codes }
  }

  return {
    newTrade,
    correct,
    settle,
    delta,
    snapshot,
    body,
    parts,
    copies: () => [...trades.values()].map((held) => held.copy),
  }
}

type Figures = Pick<
  Sums,
  "value" | "volume" | "frequency" | "buyValue" | "sellValue"
>
const figuresOf = (sums: Figures): Figures => ({
  value: sums.value,
  volume: sums.volume,
  frequency: sums.frequency,
  buyValue: sums.buyValue,
  sellValue: sums.sellValue,
})

const VIEW: BubbleView = {
  size: "value",
  colour: "delta",
  window: "D",
  top: "all",
}

// Each code's figures the page shows over `window`, ending at `end`.
const shown = (flow: MarketFlow, window: BubbleView["window"], end: number) =>
  Effect.map(bubblesOf(flow, { ...VIEW, window }, end), (bubbles) =>
    Object.fromEntries(
      bubbles.map((bubble) => [bubble.code, figuresOf(bubble)])
    )
  )

const expected = (trades: ReadonlyArray<RunningTrade>) =>
  Object.fromEntries(
    CODES.flatMap((code) => {
      const sums = sumsOf(trades.filter((trade) => trade.code === code))
      return sums.frequency === 0 ? [] : [[code, figuresOf(sums)]]
    })
  )

const inWindow = (
  trades: ReadonlyArray<RunningTrade>,
  first: number,
  last: number
) =>
  trades.filter((trade) => {
    const at = DateTime.toEpochMillis(trade.time)
    return at >= first && at < last
  })

// The page's figures equal the book's: the day and each minute from the
// trades' parts, 30s from their latest copies.
const matches = (
  flow: MarketFlow,
  server: ReturnType<typeof makeServer>,
  step: string
) =>
  Effect.gen(function* () {
    const parts = server.parts()
    expect(yield* shown(flow, "D", END), `${step}: D`).toEqual(expected(parts))
    for (let m = 0; m < MINUTES; m++) {
      const minute = T0 + m * MINUTE_MS
      expect(
        yield* shown(flow, "1m", minute + MINUTE_MS - 1),
        `${step}: 1m at ${m}`
      ).toEqual(expected(inWindow(parts, minute, minute + MINUTE_MS)))
    }
    const last = Math.floor(END / 1000) * 1000
    expect(yield* shown(flow, "30s", END), `${step}: 30s`).toEqual(
      expected(inWindow(server.copies(), last - 29_000, last + 1000))
    )
  })

const candle = (
  code: StockCode,
  minute: number,
  frequency: number
): Candle => ({
  code,
  minute: DateTime.makeUnsafe(minute),
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: frequency,
  value: frequency * 10_000,
  buyValue: 0,
  sellValue: 0,
  frequency,
})

describe("figures under feed corrections", () => {
  it.effect(
    "a snapshot hands an earlier socket's minutes back to a fresh body, not to the browser's older copy",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const [code] = CODES
        yield* applyCandles(flow, [candle(code!, T0, 2)])
        // Market Live's Select answers a snapshot on the same socket.
        const server = makeServer(random(1))
        yield* applyMessage(flow, server.snapshot())
        // The browser's copy, built before the minute's trades.
        yield* applyBubbles(flow, { codes: [] }, false)
        expect((yield* shown(flow, "D", END))[code!]?.frequency).toBe(2)
        // The Worker's, after they settled: one moved off the minute.
        yield* applyBubbles(flow, {
          codes: [
            {
              code: code!,
              previousClose: 100,
              day: [10_000, 1, 1, 0, 0, 100],
              minutes: [[T0, 10_000, 1, 1, 0, 0, 100]],
            },
          ],
        })
        expect((yield* shown(flow, "D", END))[code!]?.frequency).toBe(1)
      })
  )

  it.effect(
    "a code whose kept minutes all emptied closes at the minute before them",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const [code, other] = CODES
        yield* applyBubbles(flow, {
          codes: [
            {
              code: code!,
              previousClose: 110,
              day: [10_000, 1, 1, 0, 0, 100],
              minutes: [[T0, 10_000, 1, 1, 0, 0, 100]],
            },
          ],
        })
        // An hour and more on, another code's trade lets 10:00 go, and the
        // code trades once at 120.
        const later = T0 + (BUBBLE_MINUTES + 10) * MINUTE_MS
        yield* applyCandles(flow, [candle(other!, later, 1)])
        yield* applyCandles(flow, [{ ...candle(code!, later, 1), close: 120 }])
        // A correction moves that trade off the regular board.
        yield* applyMessage(flow, {
          _tag: "Delta",
          tape: [],
          candles: [],
          footprints: [
            { code: code!, minute: DateTime.makeUnsafe(later), cells: [] },
          ],
        })
        const [held] = (yield* bubblesOf(flow, VIEW, later)).filter(
          (bubble) => bubble.code === code
        )
        expect(held?.last).toBe(100)
        expect(held?.dayChange).toBeCloseTo(((100 - 110) / 110) * 100)
        expect(yield* marketStrip(flow)).toMatchObject({ up: 0, down: 1 })
      })
  )

  it.effect(
    "a code whose kept minutes all emptied, with no price before them, waits for a backfill",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const [code] = CODES
        // The day holds a trade from before the body's minutes, as a code
        // that traded in more minutes than the body carries does.
        yield* applyBubbles(flow, {
          codes: [
            {
              code: code!,
              previousClose: 110,
              day: [20_000, 2, 2, 0, 0, 100],
              minutes: [[T0, 10_000, 1, 1, 0, 0, 100]],
            },
          ],
        })
        expect(yield* missingFromBackfill(flow)).toBe(false)
        yield* applyMessage(flow, {
          _tag: "Delta",
          tape: [],
          candles: [],
          footprints: [
            { code: code!, minute: DateTime.makeUnsafe(T0), cells: [] },
          ],
        })
        expect(yield* missingFromBackfill(flow)).toBe(true)
      })
  )

  it.effect(
    "a minute's smaller copy, after a trade moved to the next minute, replaces its larger one",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const [code] = CODES
        yield* applyCandles(flow, [candle(code!, T0, 2)])
        // Stockbit's copy moves 10:00:59's trade to 10:01:00.
        yield* applyCandles(flow, [
          candle(code!, T0, 1),
          candle(code!, T0 + MINUTE_MS, 1),
        ])
        expect(yield* shown(flow, "D", END)).toEqual({
          [code!]: figuresOf({
            value: 20_000,
            volume: 2,
            frequency: 2,
            buyValue: 0,
            sellValue: 0,
          }),
        })
        expect(yield* shown(flow, "1m", T0 + MINUTE_MS - 1)).toEqual({
          [code!]: figuresOf({
            value: 10_000,
            volume: 1,
            frequency: 1,
            buyValue: 0,
            sellValue: 0,
          }),
        })
      })
  )

  it.effect(
    "equal a recompute from the final trades after every delta, backfill and reconnect",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 300; seed++) {
          const next = random(seed)
          const server = makeServer(next)
          const flow = yield* makeMarketFlow()
          yield* applyMessage(flow, server.snapshot())
          for (let step = 0; step < 40; step++) {
            const roll = next()
            const at = `seed ${seed} step ${step}`
            if (roll < 0.35) server.newTrade()
            else if (roll < 0.65) server.correct()
            else if (roll < 0.8) server.settle(false)
            else if (roll < 0.9) {
              yield* applyBubbles(flow, server.body())
              yield* matches(flow, server, `${at} body`)
              continue
            } else {
              // A reconnect: what changed meanwhile settles before the
              // snapshot's backfill answers.
              server.newTrade()
              server.correct()
              server.settle(true)
              yield* applyMessage(flow, server.snapshot())
              yield* applyBubbles(flow, server.body())
              yield* matches(flow, server, `${at} reconnect`)
              continue
            }
            yield* applyMessage(flow, server.delta())
            yield* matches(flow, server, `${at} delta`)
          }
        }
      }),
    30_000
  )
})
