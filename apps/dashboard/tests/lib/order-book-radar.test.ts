import { assert, describe, it } from "@effect/vitest"
import { StockCode, type BookReadings } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  DEFAULT_SETTINGS,
  rankedFigure,
  scan,
  type CodeFigures,
  type RadarSettings,
} from "@/lib/order-book-radar"

const NOW = Date.parse("2026-11-18T09:30:00+07:00")

const side = (
  depth: number,
  more: Partial<BookReadings["bid"]> = {}
): BookReadings["bid"] => ({
  depth,
  lots: depth / 100_000,
  emptyTicks: 0,
  widestGap: 0,
  lotsPerOrder: 10,
  ...more,
})

// A code's readings: worth Rp2 B today and as of 1 s ago, unless told.
const reading = (
  code: string,
  imbalance: number | undefined,
  more: Partial<BookReadings> = {}
): BookReadings => ({
  code: StockCode.make(code),
  at: DateTime.makeUnsafe(NOW - 1_000),
  value: 2e9,
  imbalance,
  spread: { ticks: 1, percent: 0.5 },
  limit: undefined,
  bid: side(100e6),
  offer: side(100e6),
  ...more,
})

const run = (
  readings: ReadonlyArray<BookReadings>,
  settings: Partial<RadarSettings> = {},
  more: {
    figures?: Record<string, Partial<CodeFigures>>
    board?: ReadonlyArray<string>
    watchlist?: ReadonlyArray<string>
  } = {}
) =>
  scan(
    {
      readings,
      figures: new Map(
        Object.entries(more.figures ?? {}).map(([code, figures]) => [
          StockCode.make(code),
          {
            last: 1_000,
            previousClose: 1_000,
            previousValue: undefined,
            ...figures,
          },
        ])
      ),
      board: new Set((more.board ?? []).map((code) => StockCode.make(code))),
      watchlist: new Set(
        (more.watchlist ?? []).map((code) => StockCode.make(code))
      ),
      now: NOW,
    },
    { ...DEFAULT_SETTINGS, ...settings }
  )

describe("which codes the scanner covers", () => {
  it.effect(
    "a code joins on today's value or the previous day's, whichever is larger",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          [
            // 09:00: nothing traded yet, Rp3 B yesterday.
            reading("ADRO", 0.2, { value: 0 }),
            reading("BBCA", 0.3, { value: 5e9 }),
            // Rp500 M today, none known for yesterday.
            reading("KOTA", 0.4, { value: 500e6 }),
            // Rp600 M today, Rp400 M yesterday.
            reading("LPKR", 0.1, { value: 600e6 }),
          ],
          {},
          {
            figures: {
              ADRO: { previousValue: 3e9 },
              LPKR: { previousValue: 400e6 },
            },
          }
        )
        assert.deepStrictEqual(result.bid, ["BBCA", "ADRO"])
        assert.strictEqual(result.above, 2)
        const lower = yield* run(
          [
            reading("KOTA", 0.4, { value: 500e6 }),
            reading("LPKR", 0.1, { value: 600e6 }),
          ],
          { floor: 100e6 }
        )
        assert.deepStrictEqual(lower.bid, ["KOTA", "LPKR"])
      })
  )

  it.effect(
    "Special Monitoring Board and Rp1–10 codes never appear and are counted",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          [
            reading("BBCA", 0.3),
            reading("MAMI", 0.5),
            reading("ZINC", -0.5),
            reading("JKSW", 0.6),
          ],
          {},
          {
            figures: {
              ZINC: { previousClose: 10 },
              // Board codes are often priced Rp1–10 too: counted once.
              MAMI: { previousClose: 8 },
            },
            board: ["MAMI", "JKSW", "SDPC"],
          }
        )
        assert.deepStrictEqual(result.bid, ["BBCA"])
        assert.deepStrictEqual(result.offer, [])
        assert.strictEqual(result.above, 1)
        assert.strictEqual(result.board, 3)
        assert.strictEqual(result.cheap, 1)
      })
  )

  it.effect("the watchlist, search and price band narrow the halves", () =>
    Effect.gen(function* () {
      const readings = [
        reading("BBCA", 0.3),
        reading("BBRI", -0.2),
        reading("TLKM", 0.1),
        reading("GOTO", -0.4),
      ]
      const figures = {
        BBCA: { last: 7_500 },
        BBRI: { last: 4_000 },
        TLKM: { last: 3_000 },
        GOTO: { last: 60 },
      }
      const watched = yield* run(
        readings,
        { codes: "watchlist" },
        { figures, watchlist: ["BBRI", "GOTO"] }
      )
      assert.deepStrictEqual(
        [watched.bid, watched.offer],
        [[], ["GOTO", "BBRI"]]
      )
      const searched = yield* run(readings, { search: "bb" }, { figures })
      assert.deepStrictEqual(
        [searched.bid, searched.offer],
        [["BBCA"], ["BBRI"]]
      )
      const banded = yield* run(
        readings,
        { priceMin: 3_000, priceMax: 5_000 },
        { figures }
      )
      assert.deepStrictEqual([banded.bid, banded.offer], [["TLKM"], ["BBRI"]])
      // The floor's count ignores the filters.
      assert.strictEqual(banded.above, 4)
    })
  )
})

describe("the halves", () => {
  it.effect(
    "split by imbalance sign; a code at a limit is listed apart, an empty book nowhere",
    () =>
      Effect.gen(function* () {
        const result = yield* run([
          reading("BBCA", 0),
          reading("BBRI", -0.1),
          reading("ARCI", 1, { limit: "upper", spread: undefined }),
          reading("KOTA", undefined, { spread: undefined }),
        ])
        assert.deepStrictEqual(result.bid, ["BBCA"])
        assert.deepStrictEqual(result.offer, ["BBRI"])
        assert.deepStrictEqual(result.limits, [
          { code: "ARCI", limit: "upper" },
        ])
      })
  )

  it.effect(
    "Rank by Imbalance puts the most lopsided first, and Low → high the least",
    () =>
      Effect.gen(function* () {
        const readings = [
          reading("AAAA", 0.2),
          reading("BBBB", 0.8),
          reading("CCCC", -0.9),
          reading("DDDD", -0.1),
        ]
        const high = yield* run(readings)
        assert.deepStrictEqual(
          [high.bid, high.offer],
          [
            ["BBBB", "AAAA"],
            ["CCCC", "DDDD"],
          ]
        )
        const low = yield* run(readings, { direction: "low" })
        assert.deepStrictEqual(
          [low.bid, low.offer],
          [
            ["AAAA", "BBBB"],
            ["DDDD", "CCCC"],
          ]
        )
      })
  )

  it.effect("every reading ranks each half in both directions", () =>
    Effect.gen(function* () {
      const readings = [
        reading("AAAA", 0.2, {
          bid: side(300e6, { emptyTicks: 1, lotsPerOrder: 5 }),
          offer: side(50e6, { emptyTicks: 0, lotsPerOrder: 5 }),
          spread: { ticks: 3, percent: 1.5 },
          at: DateTime.makeUnsafe(NOW - 20_000),
        }),
        reading("BBBB", 0.4, {
          bid: side(100e6, { emptyTicks: 4, lotsPerOrder: 50 }),
          offer: side(200e6, { emptyTicks: 2, lotsPerOrder: 20 }),
          spread: { ticks: 1, percent: 0.2 },
          at: DateTime.makeUnsafe(NOW - 2_000),
        }),
        // No spread: last whichever way.
        reading("CCCC", 0.6, {
          bid: side(200e6, { emptyTicks: 2, lotsPerOrder: 1 }),
          offer: side(0, { lotsPerOrder: undefined }),
          spread: undefined,
          at: DateTime.makeUnsafe(NOW - 10_000),
        }),
        reading("DDDD", -0.3),
      ]
      const ranked = (settings: Partial<RadarSettings>) =>
        Effect.map(run(readings, settings), ({ bid, offer }) => ({
          bid,
          offer,
        }))
      const cases: ReadonlyArray<
        readonly [RadarSettings["rankBy"], ReadonlyArray<string>]
      > = [
        ["bidDepth", ["AAAA", "CCCC", "BBBB"]],
        ["offerDepth", ["BBBB", "AAAA", "CCCC"]],
        ["emptyTicks", ["BBBB", "CCCC", "AAAA"]],
        ["lotsPerOrder", ["BBBB", "AAAA", "CCCC"]],
        ["bookAge", ["AAAA", "CCCC", "BBBB"]],
      ]
      for (const [rankBy, order] of cases) {
        assert.deepStrictEqual(yield* ranked({ rankBy }), {
          bid: order,
          offer: ["DDDD"],
        })
        assert.deepStrictEqual(yield* ranked({ rankBy, direction: "low" }), {
          bid: [...order].reverse(),
          offer: ["DDDD"],
        })
      }
      assert.deepStrictEqual((yield* ranked({ rankBy: "spread" })).bid, [
        "AAAA",
        "BBBB",
        "CCCC",
      ])
      assert.deepStrictEqual(
        (yield* ranked({ rankBy: "spread", direction: "low" })).bid,
        ["BBBB", "AAAA", "CCCC"]
      )
    })
  )

  it.effect("a book unchanged for 60 s sinks to the end of its half", () =>
    Effect.gen(function* () {
      const result = yield* run([
        reading("AAAA", 0.9, { at: DateTime.makeUnsafe(NOW - 61_000) }),
        reading("BBBB", 0.1),
      ])
      assert.deepStrictEqual(result.bid, ["BBBB", "AAAA"])
      const low = yield* run(
        [
          reading("AAAA", 0.1, { at: DateTime.makeUnsafe(NOW - 61_000) }),
          reading("BBBB", 0.9),
        ],
        { direction: "low" }
      )
      assert.deepStrictEqual(low.bid, ["BBBB", "AAAA"])
    })
  )
})

describe("the ranked figure", () => {
  it.effect(
    "shows the heavy side's near depth for Imbalance, else the reading ranked",
    () =>
      Effect.gen(function* () {
        const readings = reading("BBCA", -0.2, {
          bid: side(1.5e9, { emptyTicks: 1, lotsPerOrder: 12.4 }),
          offer: side(2.25e9, { emptyTicks: 3, lotsPerOrder: 30 }),
          spread: { ticks: 2, percent: 0.6667 },
        })
        assert.strictEqual(
          yield* rankedFigure(readings, "imbalance", NOW),
          "Rp2.25 B"
        )
        assert.strictEqual(
          yield* rankedFigure(readings, "bidDepth", NOW),
          "Rp1.5 B"
        )
        assert.strictEqual(
          yield* rankedFigure(readings, "emptyTicks", NOW),
          "1 / 3 empty"
        )
        assert.strictEqual(
          yield* rankedFigure(readings, "spread", NOW),
          "2t · 0.67%"
        )
        assert.strictEqual(
          yield* rankedFigure(readings, "lotsPerOrder", NOW),
          "12 / 30 lots/ord"
        )
        assert.strictEqual(yield* rankedFigure(readings, "bookAge", NOW), "1s")
      })
  )
})
