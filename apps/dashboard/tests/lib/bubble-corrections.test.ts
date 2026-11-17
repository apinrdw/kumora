// Market Bubbles' figures under the feed's corrections: random runs of
// trades that Stockbit's copies retime across a minute, re-side or move off
// the regular board, against a model of the candle book (candles.ts), whose
// latest copy of a minute is the authority, and late trades that land in
// minutes older than the hour the page keeps. After each delta, body and
// reconnect, the page's figures equal a recompute from the trades' final
// parts, and the windows end at its newest trade.
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
  windowEnd,
  type BubbleView,
  type MarketFlow,
} from "@/lib/bubbles"
import { marketStrip } from "@/lib/market-strip"

// 10:00:00 WIB on a trading day.
const T0 = Date.parse("2026-11-16T03:00:00Z")
const CODES = [StockCode.make("AAAA"), StockCode.make("BBBB")]
const MINUTES = 4
// Trades fill MINUTES minutes from T0, then, once the run jumps, MINUTES
// from LATER, past the hour the page keeps, while late ones still land in
// the first block.
const LATER = T0 + (BUBBLE_MINUTES + MINUTES) * MINUTE_MS
const BLOCKS = [T0, LATER]
const DAY_MINUTES = BLOCKS.flatMap((start) =>
  Array.from({ length: MINUTES }, (_, m) => start + m * MINUTE_MS)
)
const blockEnd = (start: number) => start + MINUTES * MINUTE_MS - 1
const END = blockEnd(LATER)

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
// counts, which follows the latest only while the merge window is open; and
// when it reached the book.
interface Held {
  copy: RunningTrade
  part: RunningTrade
  open: boolean
  readonly arrivedAt: number
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
  // The book's clock: each step is a millisecond on.
  let now = 0
  const tick = () => ++now

  const parts = () =>
    [...trades.values()].flatMap((held) =>
      held.part.board === "RG" ? [held.part] : []
    )
  const touch = (trade: RunningTrade) => {
    if (trade.board === "RG") changed.add(`${trade.code} ${minuteOf(trade)}`)
  }
  const pick = <A>(from: ReadonlyArray<A>) =>
    from[Math.floor(next() * from.length)]!

  // The block new trades land in, and how many it has.
  let block = T0
  let inBlock = 0

  // Trade numbers follow time, as the exchange's do: a trade lands up to
  // 10 s after the one numbered before it. A late one lands anywhere in the
  // first block, an hour and more before the trades around it once the run
  // jumped.
  const newTrade = (late = false) => {
    const at = late
      ? T0 + Math.floor(next() * MINUTES * MINUTE_MS)
      : block + inBlock++ * 10_000 + Math.floor(next() * 10_000)
    const trade: RunningTrade = {
      tradeNumber: TradeNumber.make(String(number++)),
      time: DateTime.makeUnsafe(Math.min(blockEnd(late ? T0 : block), at)),
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
      arrivedAt: tick(),
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
    const start = at >= LATER ? LATER : T0
    const kind = next()
    const copy: RunningTrade = {
      ...held.copy,
      feeds: ["Ajaib", "Stockbit"],
      ...(kind < 0.4
        ? {
            time: DateTime.makeUnsafe(
              Math.min(
                blockEnd(start),
                Math.max(start, at + Math.floor((next() - 0.5) * 3_000))
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
      at: DateTime.makeUnsafe(tick()),
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
      at: DateTime.makeUnsafe(tick()),
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

  // The backfill: the settled parts only, settled before the oldest trade
  // still open.
  const body = (): RecordedBubbles => {
    let settledBefore = tick()
    for (const held of trades.values())
      if (held.open) settledBefore = Math.min(settledBefore, held.arrivedAt)
    const settled = [...trades.values()].flatMap((held) =>
      held.open || held.part.board !== "RG" ? [] : [held.part]
    )
    const codes: Array<RecordedBubbles["codes"][number]> = []
    for (const code of CODES) {
      const minutes: Array<
        RecordedBubbles["codes"][number]["minutes"][number]
      > = []
      for (const minute of DAY_MINUTES) {
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
        ],
        minutes,
      })
    }
    return { settledBefore, codes }
  }

  return {
    newTrade,
    // New trades land from LATER on, while trades before it may still be in
    // their merge window, as at session 2's first trade.
    jump: () => {
      block = LATER
      inBlock = 0
    },
    jumped: () => block === LATER,
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

// Each code's last price on the page, and its day change against the body's
// previous close of 100, none before a body brought it.
const lastPrices = (flow: MarketFlow) =>
  Effect.map(bubblesOf(flow, VIEW, END), (bubbles) =>
    Object.fromEntries(
      bubbles.map((bubble) => [
        bubble.code,
        {
          last: bubble.last,
          dayChange: bubble.dayChange ?? (bubble.last ?? 0) - 100,
        },
      ])
    )
  )

// The book's last price of each code: the close of its newest minute with a
// regular-board part, which is that minute's highest-numbered part's price.
const expectedLast = (parts: ReadonlyArray<RunningTrade>) =>
  Object.fromEntries(
    CODES.flatMap((code) => {
      const own = parts.filter((trade) => trade.code === code)
      if (own.length === 0) return []
      const newest = Math.max(...own.map(minuteOf))
      const last = sumsOf(inMinute(own, code, newest)).close
      return [[code, { last, dayChange: last - 100 }]]
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

// The page's figures equal the book's: the day and each minute it keeps from
// the trades' parts, 30s from their latest copies. While a late trade waits
// for a backfill to recount the day, the day is the body's, and a code's
// last price is the book's or, when the page let the minutes before it go,
// none; never another.
const matches = (
  flow: MarketFlow,
  server: ReturnType<typeof makeServer>,
  step: string
) =>
  Effect.gen(function* () {
    const parts = server.parts()
    const book = expectedLast(parts)
    if (flow.recountFrom === undefined) {
      expect(yield* shown(flow, "D", END), `${step}: D`).toEqual(
        expected(parts)
      )
      expect(yield* lastPrices(flow), `${step}: last price`).toEqual(book)
    } else
      for (const [code, { last }] of Object.entries(yield* lastPrices(flow)))
        if (last !== undefined)
          expect(last, `${step}: ${code}'s last price`).toBe(book[code]?.last)
    const oldestKept = flow.newestMinute - (BUBBLE_MINUTES - 1) * MINUTE_MS
    for (const minute of DAY_MINUTES) {
      if (minute < oldestKept) continue
      expect(
        yield* shown(flow, "1m", minute + MINUTE_MS - 1),
        `${step}: 1m at ${(minute - T0) / MINUTE_MS}`
      ).toEqual(expected(inWindow(parts, minute, minute + MINUTE_MS)))
    }
    const last = Math.floor(END / 1000) * 1000
    expect(yield* shown(flow, "30s", END), `${step}: 30s`).toEqual(
      expected(inWindow(server.copies(), last - 29_000, last + 1000))
    )
    // Out of session the windows end at the newest regular-board trade the
    // page still counts: a tape copy's time, or a part's minute start where
    // only its candle tells.
    let newest: number | undefined
    for (const at of [
      ...server
        .copies()
        .flatMap((copy) =>
          copy.board === "RG" ? [DateTime.toEpochMillis(copy.time)] : []
        ),
      ...parts.map(minuteOf),
    ])
      if (newest === undefined || at > newest) newest = at
    // Once corrections empty the block after the jump, the newest trade is
    // an hour back, whose tape the page let go for the block's: the end is
    // no earlier than the newest part's minute start, and none only when no
    // part is left. While a recount waits, the page may no longer hold that
    // minute: no end then.
    const end = (yield* windowEnd(flow, "break", END + MINUTE_MS))?.end
    if (flow.recountFrom !== undefined && end === undefined) return
    if (!server.jumped() || newest === undefined || newest >= LATER) {
      expect(end, `${step}: end`).toBe(newest)
      return
    }
    const newestPart =
      parts.length === 0 ? undefined : Math.max(...parts.map(minuteOf))
    expect(
      end === undefined
        ? newestPart === undefined
        : end >= (newestPart ?? end) && end <= newest,
      `${step}: end ${end} against part ${newestPart}, trade ${newest}`
    ).toBe(true)
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
    "a snapshot hands an earlier socket's minutes back to a body settled past it, not to one settled before it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const [code] = CODES
        yield* applyCandles(flow, [candle(code!, T0, 2)])
        // Market Live's Select answers a snapshot on the same socket, sent
        // at 1 ms on the book's clock.
        const server = makeServer(random(1))
        yield* applyMessage(flow, server.snapshot())
        // The browser's copy, built before the minute's trades.
        yield* applyBubbles(flow, { settledBefore: 0, codes: [] })
        expect((yield* shown(flow, "D", END))[code!]?.frequency).toBe(2)
        // The Worker's, after they settled: one moved off the minute.
        yield* applyBubbles(flow, {
          settledBefore: 2,
          codes: [
            {
              code: code!,
              previousClose: 100,
              day: [10_000, 1, 1, 0, 0],
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
          settledBefore: T0,
          codes: [
            {
              code: code!,
              previousClose: 110,
              day: [10_000, 1, 1, 0, 0],
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
          at: DateTime.makeUnsafe(later),
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
          settledBefore: T0,
          codes: [
            {
              code: code!,
              previousClose: 110,
              day: [20_000, 2, 2, 0, 0],
              minutes: [[T0, 10_000, 1, 1, 0, 0, 100]],
            },
          ],
        })
        expect(yield* missingFromBackfill(flow)).toBe(false)
        yield* applyMessage(flow, {
          _tag: "Delta",
          at: DateTime.makeUnsafe(T0 + 1_000),
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
            if (roll < 0.3) server.newTrade()
            else if (roll < 0.38) {
              // A late trade lands once the page let the first block go.
              if (!server.jumped()) server.jump()
              else server.newTrade(flow.newestMinute >= LATER)
            } else if (roll < 0.65) server.correct()
            else if (roll < 0.8) server.settle(false)
            else if (roll < 0.9) {
              yield* applyBubbles(flow, server.body())
              yield* matches(flow, server, `${at} body`)
              continue
            } else {
              // A reconnect: what changed meanwhile, then the snapshot's
              // backfill, which may be built while trades are still open,
              // and one built once they settled.
              server.newTrade()
              server.correct()
              yield* applyMessage(flow, server.snapshot())
              yield* applyBubbles(flow, server.body())
              server.settle(true)
              yield* applyBubbles(flow, server.body())
              yield* matches(flow, server, `${at} reconnect`)
              expect({ at, waits: yield* missingFromBackfill(flow) }).toEqual({
                at,
                waits: false,
              })
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
