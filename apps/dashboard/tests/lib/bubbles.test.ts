import { describe, expect, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type Candle,
  type RecordedBubbles,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  applyBubbles,
  applyCandles,
  applyTrades,
  BUBBLE_WINDOWS,
  bubbleScale,
  bubbleTone,
  bubblesOf,
  makeMarketFlow,
  missingFromBackfill,
  sizeFigure,
  windowEnd,
  type BubbleView,
  type BubbleWindow,
  type MarketFlow,
} from "@/lib/bubbles"

// 10:00:00 WIB on a trading day.
const T0 = Date.parse("2026-11-16T03:00:00Z")
const MIN = 60_000

const VIEW: BubbleView = {
  size: "value",
  colour: "delta",
  window: "5m",
  top: 100,
}

// A body minute: [minute, value, volume, frequency, buy, sell, close].
const minute = (
  at: number,
  value: number,
  close: number,
  buy = 0,
  sell = 0
): RecordedBubbles["codes"][number]["minutes"][number] => [
  at,
  value,
  value / (close * 100),
  1,
  buy,
  sell,
  close,
]

const body = (
  codes: ReadonlyArray<{
    code: string
    previousClose?: number
    minutes: RecordedBubbles["codes"][number]["minutes"]
  }>
): RecordedBubbles => ({
  codes: codes.map(({ code, previousClose, minutes }) => {
    const sum = (i: 1 | 2 | 3 | 4 | 5) =>
      minutes.reduce((total, row) => total + row[i], 0)
    return {
      code: StockCode.make(code),
      ...(previousClose === undefined ? {} : { previousClose }),
      day: [sum(1), sum(2), sum(3), sum(4), sum(5), minutes.at(-1)?.[6] ?? 0],
      minutes,
    }
  }),
})

describe("minute windows", () => {
  it.effect(
    "5m is the current minute so far and the four before it, stepping at the minute",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              minutes: [
                minute(T0 - 5 * MIN, 1_000, 100),
                minute(T0 - 4 * MIN, 2_000, 100),
                minute(T0, 4_000, 100),
              ],
            },
          ])
        )
        const at = (end: number) =>
          Effect.map(bubblesOf(flow, VIEW, end), (shown) =>
            shown.map((bubble) => [bubble.code, bubble.value])
          )
        // 10:00:30: 09:56 to 10:00, so 09:55 is out.
        expect(yield* at(T0 + 30_000)).toEqual([["BBCA", 6_000]])
        // 10:03:59: 09:59 to 10:03, the last minute 09:56 left at 10:01.
        expect(yield* at(T0 + 3 * MIN + 59_000)).toEqual([["BBCA", 4_000]])
        // 10:05:00: only 10:01 onwards, so nothing traded in the window.
        expect(yield* at(T0 + 5 * MIN)).toEqual([])
      })
  )
})

const candle = (
  code: string,
  at: number,
  figures: {
    value: number
    close: number
    frequency: number
    buyValue?: number
    sellValue?: number
  }
): Candle => ({
  code: StockCode.make(code),
  minute: DateTime.makeUnsafe(at),
  open: figures.close,
  high: figures.close,
  low: figures.close,
  close: figures.close,
  volume: figures.value / (figures.close * 100),
  value: figures.value,
  buyValue: figures.buyValue ?? 0,
  sellValue: figures.sellValue ?? 0,
  frequency: figures.frequency,
})

let tradeNumber = 1
const trade = (
  code: string,
  at: number,
  figures: {
    price: number
    lots: number
    side?: "buy" | "sell" | "none"
    board?: "RG" | "TN" | "NG"
    number?: number
  }
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(figures.number ?? tradeNumber++)),
  time: DateTime.makeUnsafe(at),
  code: StockCode.make(code),
  price: figures.price,
  lots: figures.lots,
  side: figures.side ?? "buy",
  board: figures.board ?? "RG",
  feeds: ["Ajaib"],
})

const valuesAt = (flow: MarketFlow, view: BubbleView, end: number) =>
  Effect.map(bubblesOf(flow, view, end), (shown) =>
    shown.map((bubble) => [bubble.code, bubble.value])
  )

describe("the 30s window", () => {
  it.effect("rolls by the second over the tape's regular-board trades", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      yield* applyTrades(flow, [
        trade("BBCA", T0 + 1_500, { price: 100, lots: 1 }),
        trade("BBCA", T0 + 20_000, { price: 100, lots: 2 }),
        // Not the regular board: left out.
        trade("BBCA", T0 + 20_000, { price: 100, lots: 50, board: "NG" }),
      ])
      const view = { ...VIEW, window: "30s" } as const
      expect(yield* valuesAt(flow, view, T0 + 30_999)).toEqual([
        ["BBCA", 30_000],
      ])
      // At 10:00:31 the trade at 10:00:01 has left.
      expect(yield* valuesAt(flow, view, T0 + 31_000)).toEqual([
        ["BBCA", 20_000],
      ])
      expect(yield* valuesAt(flow, view, T0 + 50_000)).toEqual([])
    })
  )

  it.effect("counts a trade once when a snapshot's tape repeats it", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      const once = trade("BBCA", T0, { price: 100, lots: 1 })
      yield* applyTrades(flow, [once])
      yield* applyTrades(flow, [once])
      expect(
        yield* valuesAt(flow, { ...VIEW, window: "30s" }, T0 + 1_000)
      ).toEqual([["BBCA", 10_000]])
    })
  )

  it.effect(
    "takes a repeated trade's corrected side and second in place of its first copy",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        // Ajaib's copy first, then Stockbit's: the other side, a moment later.
        yield* applyTrades(flow, [
          trade("BBCA", T0 + 999, { price: 100, lots: 1, number: 7 }),
        ])
        yield* applyTrades(flow, [
          trade("BBCA", T0 + 1_000, {
            price: 100,
            lots: 1,
            side: "sell",
            number: 7,
          }),
        ])
        // 10:00:01 to 10:00:30: the corrected second only.
        const [bubble] = yield* bubblesOf(
          flow,
          { ...VIEW, window: "30s" },
          T0 + 30_999
        )
        expect(bubble).toMatchObject({
          value: 10_000,
          frequency: 1,
          buyValue: 0,
          sellValue: 10_000,
        })
      })
  )

  it.effect(
    "closes a second a corrected trade left at the trade still in it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyTrades(flow, [
          trade("BBCA", T0 + 100, { price: 100, lots: 1, number: 7 }),
          trade("BBCA", T0 + 900, { price: 105, lots: 1, number: 8 }),
        ])
        yield* applyTrades(flow, [
          trade("BBCA", T0 + 1_000, { price: 105, lots: 1, number: 8 }),
        ])
        // 10:00:01 to 10:00:30, against 10:00:00's close: trade 7's 100.
        const [bubble] = yield* bubblesOf(
          flow,
          { ...VIEW, window: "30s" },
          T0 + 30_999
        )
        expect(bubble?.change).toBeCloseTo(5)
      })
  )

  it.effect("changes against the price 30 s before", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      yield* applyTrades(flow, [
        trade("BBCA", T0, { price: 100, lots: 1 }),
        trade("BBCA", T0 + 40_000, { price: 103, lots: 1 }),
      ])
      const [bubble] = yield* bubblesOf(
        flow,
        { ...VIEW, window: "30s" },
        T0 + 41_000
      )
      expect(bubble?.change).toBeCloseTo(3)
    })
  )
})

describe("the day window", () => {
  it.effect(
    "is the backfill's totals plus each delta minute over the backfill's copy",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              previousClose: 100,
              minutes: [minute(T0 - MIN, 1_000, 100), minute(T0, 2_000, 101)],
            },
          ])
        )
        // The body's 10:00 is missing its last trades; 10:01 is new.
        yield* applyCandles(flow, [
          candle("BBCA", T0, { value: 2_500, close: 101, frequency: 2 }),
          candle("BBCA", T0 + MIN, { value: 700, close: 102, frequency: 1 }),
        ])
        const [bubble] = yield* bubblesOf(
          flow,
          { ...VIEW, window: "D" },
          T0 + MIN
        )
        expect(bubble?.value).toBe(4_200)
        expect(bubble?.change).toBeCloseTo(2)
      })
  )

  it.effect(
    "counts nothing twice when a reconnect's backfill comes after the deltas",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        // Deltas first, as on a socket that opened before the GET answered.
        yield* applyCandles(flow, [
          candle("BBCA", T0, { value: 2_000, close: 100, frequency: 2 }),
          candle("BBCA", T0 + MIN, { value: 500, close: 100, frequency: 1 }),
        ])
        // The backfill built before 10:01 and before 10:00's last trade.
        const older = body([
          {
            code: "BBCA",
            minutes: [minute(T0 - MIN, 1_000, 100), minute(T0, 1_200, 100)],
          },
        ])
        yield* applyBubbles(flow, older)
        // The same one again, as a second reconnect may answer.
        yield* applyBubbles(flow, older)
        const at = T0 + MIN
        expect(yield* valuesAt(flow, { ...VIEW, window: "D" }, at)).toEqual([
          ["BBCA", 3_500],
        ])
        expect(yield* valuesAt(flow, VIEW, at)).toEqual([["BBCA", 3_500]])
      })
  )

  it.effect("has no change, and colours grey, with no previous close", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      yield* applyBubbles(
        flow,
        body([{ code: "BBCA", minutes: [minute(T0, 1_000, 100)] }])
      )
      const view = { ...VIEW, window: "D", colour: "change" } as const
      const [bubble] = yield* bubblesOf(flow, view, T0)
      expect(bubble?.change).toBeUndefined()
      expect(yield* bubbleTone(bubble!, view)).toBeUndefined()
    })
  )
})

describe("Buy/Sell delta % and price change %", () => {
  it.effect("delta is buy less sell over their sum, and 0 with neither", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      yield* applyCandles(flow, [
        candle("BBCA", T0, {
          value: 1_000,
          close: 100,
          frequency: 3,
          buyValue: 600,
          sellValue: 200,
        }),
        candle("BBRI", T0, { value: 500, close: 100, frequency: 1 }),
      ])
      const shown = yield* bubblesOf(flow, VIEW, T0)
      expect(shown.map((bubble) => [bubble.code, bubble.buySellDelta])).toEqual(
        [
          ["BBCA", 50],
          ["BBRI", 0],
        ]
      )
      expect(yield* bubbleTone(shown[0]!, VIEW)).toBeCloseTo(0.5)
    })
  )

  it.effect(
    "change compares the last price with the close of the minute before the window",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              previousClose: 50,
              minutes: [
                minute(T0 - 5 * MIN, 1_000, 200),
                minute(T0 - 2 * MIN, 1_000, 210),
                minute(T0, 1_000, 205),
              ],
            },
          ])
        )
        const view = { ...VIEW, colour: "change" } as const
        const at = (window: BubbleWindow) =>
          Effect.map(
            bubblesOf(flow, { ...view, window }, T0 + 10_000),
            ([bubble]) => bubble?.change
          )
        // 5m starts at 09:56: the minute before is 09:55's 200.
        expect(yield* at("5m")).toBeCloseTo(2.5)
        // 1m starts at 10:00: the last close before is 09:58's 210.
        expect(yield* at("1m")).toBeCloseTo(-2.381, 2)
        // 15m starts before every minute held: the previous close.
        expect(yield* at("15m")).toBeCloseTo(310)
      })
  )

  it.effect(
    "change of a thin code compares with its last close before the minutes kept",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        // BBCA last traded 100 minutes ago, past the 61 minutes kept.
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              previousClose: 50,
              minutes: [
                minute(T0 - 100 * MIN, 1_000, 200),
                minute(T0, 1_000, 210),
              ],
            },
          ])
        )
        const view = { ...VIEW, colour: "change" } as const
        const at = (window: BubbleWindow) =>
          Effect.map(
            bubblesOf(flow, { ...view, window }, T0 + 10_000),
            ([bubble]) => bubble?.change
          )
        expect(yield* at("1m")).toBeCloseTo(5)
        expect(yield* at("1h")).toBeCloseTo(5)
        // A later candle moves the market on; the close before still holds.
        yield* applyCandles(flow, [
          candle("BBCA", T0 + 70 * MIN, { value: 1, close: 220, frequency: 1 }),
        ])
        const [bubble] = yield* bubblesOf(
          flow,
          { ...view, window: "1m" },
          T0 + 70 * MIN
        )
        expect(bubble?.change).toBeCloseTo(4.762, 2)
      })
  )

  it.effect("change colours over its window's range, clamped", () =>
    Effect.gen(function* () {
      const bubble = {
        code: StockCode.make("BBCA"),
        value: 1,
        volume: 1,
        frequency: 1,
        buyValue: 0,
        sellValue: 0,
        buySellDelta: 0,
        change: 1.5,
        dayChange: undefined,
        last: 1,
        size: 1,
      }
      const tone = (window: BubbleWindow, change: number) =>
        bubbleTone({ ...bubble, change }, { ...VIEW, colour: "change", window })
      expect(yield* tone("30s", 0.3)).toBeCloseTo(0.5)
      expect(yield* tone("1m", -0.5)).toBeCloseTo(-0.5)
      expect(yield* tone("5m", 1)).toBeCloseTo(0.5)
      expect(yield* tone("15m", 1.5)).toBeCloseTo(0.5)
      expect(yield* tone("30m", 2)).toBeCloseTo(0.5)
      expect(yield* tone("1h", 2.5)).toBeCloseTo(0.5)
      expect(yield* tone("D", 4)).toBeCloseTo(0.5)
      expect(yield* tone("5m", -9)).toBe(-1)
    })
  )
})

describe("the universe and Top N", () => {
  it.effect(
    "shows only codes that traded in the window, the top N by the size metric",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        const codes = Array.from({ length: 120 }, (_, i) =>
          candle(`C${String(i).padStart(3, "0")}`, T0, {
            value: 1_000 + i,
            close: 100,
            // Frequency runs the other way from value.
            frequency: 200 - i,
          })
        )
        // Traded before the window only.
        codes.push(
          candle("OLD", T0 - 10 * MIN, { value: 1e9, close: 100, frequency: 1 })
        )
        yield* applyCandles(flow, codes)
        const byValue = yield* bubblesOf(flow, VIEW, T0)
        expect(byValue).toHaveLength(100)
        expect(byValue[0]?.code).toBe("C119")
        expect(byValue.at(-1)?.code).toBe("C020")
        const byFreq = yield* bubblesOf(
          flow,
          { ...VIEW, size: "freq", top: 50 },
          T0
        )
        expect(byFreq).toHaveLength(50)
        expect(byFreq[0]?.code).toBe("C000")
        const all = yield* bubblesOf(flow, { ...VIEW, top: "all" }, T0)
        expect(all).toHaveLength(120)
        expect(all.some((bubble) => bubble.code === "OLD")).toBe(false)
      })
  )

  it.effect("leaves indices out", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      yield* applyCandles(flow, [
        candle("IHSG", T0, { value: 1e12, close: 7000, frequency: 9 }),
      ])
      expect(yield* bubblesOf(flow, VIEW, T0)).toEqual([])
    })
  )
})

describe("out-of-session window ends", () => {
  it.effect(
    "end now in a session, at the day's last trade outside one, and none before the first trade",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        expect(yield* windowEnd(flow, "session-1", T0)).toBeUndefined()
        yield* applyCandles(flow, [
          candle("BBCA", T0, { value: 1, close: 1, frequency: 1 }),
        ])
        // A candle alone tells only the minute.
        expect(yield* windowEnd(flow, "break", T0 + 2 * MIN)).toEqual({
          end: T0,
          closed: true,
        })
        yield* applyTrades(flow, [
          trade("BBCA", T0 + 58_000, { price: 1, lots: 1 }),
        ])
        for (const phase of ["session-1", "session-2"] as const)
          expect(yield* windowEnd(flow, phase, T0 + 2 * MIN)).toEqual({
            end: T0 + 2 * MIN,
            closed: false,
          })
        for (const phase of [
          "break",
          "pre-closing",
          "post-trading",
          "closed",
        ] as const)
          expect(yield* windowEnd(flow, phase, T0 + 2 * MIN)).toEqual({
            end: T0 + 58_000,
            closed: true,
          })
      })
  )
})

describe("radii and labels", () => {
  it.effect(
    "sizes by the root of the metric to fill about 34 % of the canvas, with a floor",
    () =>
      Effect.gen(function* () {
        const { k, minRadius } = yield* bubbleScale([400, 100], 1000, 500)
        const area = (size: number) => Math.PI * (k * Math.sqrt(size)) ** 2
        expect((area(400) + area(100)) / (1000 * 500)).toBeCloseTo(0.34)
        expect(k * Math.sqrt(400)).toBeCloseTo(2 * k * Math.sqrt(100))
        expect(minRadius).toBe(7)
        expect(
          (yield* bubbleScale(
            Array.from({ length: 301 }, () => 1),
            1000,
            1000
          )).minRadius
        ).toBe(4)
      })
  )

  it.effect("keeps the largest bubble within the canvas's height", () =>
    Effect.gen(function* () {
      // One code far larger than the rest, on Market Live's short panel.
      const sizes = [1_000_000, 1, 1]
      const { k } = yield* bubbleScale(sizes, 1300, 278)
      expect(2 * k * Math.sqrt(1_000_000)).toBeCloseTo(278)
    })
  )

  it.effect("writes rupiah as M, B or T and lots and trades as K or M", () =>
    Effect.gen(function* () {
      expect(yield* sizeFigure("value", 2_345_000)).toBe("Rp2.35 M")
      expect(yield* sizeFigure("value", 1_234_567_890)).toBe("Rp1.23 B")
      expect(yield* sizeFigure("value", 3_210_000_000_000)).toBe("Rp3.21 T")
      expect(yield* sizeFigure("volume", 12_500)).toBe("12.50 K lots")
      expect(yield* sizeFigure("volume", 640)).toBe("640 lots")
      expect(yield* sizeFigure("freq", 2_100_000)).toBe("2.10 M trades")
    })
  )
})

describe("recompute time", () => {
  // Read the timing off its "Recompute" line with `--silent=false`.
  it.live(
    "stays under 2 ms for 900 codes",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        // A busy hour: 900 codes, each with 60 minutes and a trade in each
        // of the last 30 seconds' tape.
        yield* applyBubbles(
          flow,
          body(
            Array.from({ length: 900 }, (_, i) => ({
              code: `B${String(i).padStart(3, "0")}`,
              previousClose: 100,
              minutes: Array.from({ length: 60 }, (_row, m) =>
                minute(
                  T0 - (59 - m) * MIN,
                  1e6 + i * m,
                  100 + (m % 7),
                  4e5,
                  3e5
                )
              ),
            }))
          )
        )
        yield* applyTrades(
          flow,
          Array.from({ length: 900 * 30 }, (_, i) =>
            trade(
              `B${String(i % 900).padStart(3, "0")}`,
              T0 + (i % 30) * 1000,
              {
                price: 100,
                lots: 1 + (i % 5),
                number: 1_000_000 + i,
              }
            )
          )
        )
        const times: Array<number> = []
        for (const window of BUBBLE_WINDOWS)
          for (let run = 0; run < 20; run++) {
            const started = performance.now()
            const shown = yield* bubblesOf(
              flow,
              { ...VIEW, window, top: "all" },
              T0 + 29_999
            )
            for (const bubble of shown) yield* bubbleTone(bubble, VIEW)
            times.push(performance.now() - started)
            expect(shown).toHaveLength(900)
          }
        times.sort((a, b) => a - b)
        const median = times[Math.floor(times.length / 2)]!
        yield* Effect.logInfo(
          `Recompute, 900 codes: median ${median.toFixed(2)} ms, worst ${times.at(-1)!.toFixed(2)} ms`
        )
        expect(median).toBeLessThan(2)
      }),
    10_000
  )
})

describe("day totals a backfill recounts", () => {
  it.effect("wait for one when a candle older than the kept hour changes", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      const minutes = [minute(T0 - 2 * 60 * MIN, 1_000, 100)]
      for (let m = 60; m >= 0; m--) minutes.push(minute(T0 - m * MIN, 1, 100))
      yield* applyBubbles(
        flow,
        body([{ code: "BBCA", previousClose: 100, minutes }])
      )
      expect(yield* missingFromBackfill(flow)).toBe(false)
      // A relay backfill page brings a trade two hours back.
      yield* applyCandles(flow, [
        candle("BBCA", T0 - 2 * 60 * MIN, {
          value: 2_000,
          close: 100,
          frequency: 2,
        }),
      ])
      expect(yield* missingFromBackfill(flow)).toBe(true)
      yield* applyBubbles(
        flow,
        body([{ code: "BBCA", previousClose: 100, minutes }])
      )
      expect(yield* missingFromBackfill(flow)).toBe(false)
    })
  )
})

describe("codes the backfill hasn't carried", () => {
  it.effect(
    "are the codes first seen in a delta or the tape, until a backfill carries them",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              previousClose: 100,
              minutes: [minute(T0, 1_000, 100)],
            },
          ])
        )
        expect(yield* missingFromBackfill(flow)).toBe(false)
        // BBRI first trades after the backfill loaded: no previous close yet.
        yield* applyCandles(flow, [
          candle("BBRI", T0 + MIN, { value: 500, close: 100, frequency: 1 }),
        ])
        expect(yield* missingFromBackfill(flow)).toBe(true)
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBCA",
              previousClose: 100,
              minutes: [minute(T0, 1_000, 100)],
            },
            {
              code: "BBRI",
              previousClose: 98,
              minutes: [minute(T0 + MIN, 500, 100)],
            },
          ])
        )
        expect(yield* missingFromBackfill(flow)).toBe(false)
        const [bubble] = yield* bubblesOf(
          flow,
          { ...VIEW, window: "D", top: "all" },
          T0 + MIN
        ).pipe(Effect.map((shown) => shown.filter((b) => b.code === "BBRI")))
        expect(bubble?.dayChange).toBeCloseTo(2.041, 2)
      })
  )

  it.effect(
    "keep the flow waiting while a carried code has no previous close, until one carries it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        // No `liveprice` frame had come for BBRI when the body was built.
        yield* applyBubbles(
          flow,
          body([{ code: "BBRI", minutes: [minute(T0, 500, 100)] }])
        )
        expect(yield* missingFromBackfill(flow)).toBe(true)
        yield* applyBubbles(
          flow,
          body([
            {
              code: "BBRI",
              previousClose: 98,
              minutes: [minute(T0, 500, 100)],
            },
          ])
        )
        expect(yield* missingFromBackfill(flow)).toBe(false)
      })
  )
})
