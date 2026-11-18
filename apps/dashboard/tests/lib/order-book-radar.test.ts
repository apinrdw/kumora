import { assert, describe, it } from "@effect/vitest"
import { StockCode, type BookEvent, type BookReadings } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  DEFAULT_SETTINGS,
  coverageNote,
  rankedFigure,
  scan,
  type CodeEvents,
  type CodeFigures,
  type RadarSettings,
} from "@/lib/order-book-radar"

const NOW = Date.parse("2026-11-18T09:30:00+07:00")

const side = (
  nearDepth: number,
  more: Partial<BookReadings["bid"]> = {}
): BookReadings["bid"] => ({
  nearDepth,
  lots: nearDepth / 100_000,
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

// A wall that appeared on `code`'s bid at `at`.
const wall = (code: string, at: number): BookEvent => ({
  kind: "appeared",
  code: StockCode.make(code),
  at: DateTime.makeUnsafe(at),
  side: "bid",
  price: 1_000,
  lots: 6_000,
  orders: 2,
  ticks: 2,
})

// A scan as the tests compare it: its codes as plain strings.
interface Plain {
  readonly bid: ReadonlyArray<string>
  readonly offer: ReadonlyArray<string>
  readonly limits: ReadonlyArray<{
    readonly code: string
    readonly limit: string
  }>
  readonly above: number
  readonly board: number
  readonly cheap: number
}

const run = (
  readings: ReadonlyArray<BookReadings>,
  settings: Partial<RadarSettings> = {},
  more: {
    figures?: Record<string, Partial<CodeFigures>>
    board?: ReadonlyArray<string>
    watchlist?: ReadonlyArray<string>
    events?: Record<string, CodeEvents>
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
      events: new Map(
        Object.entries(more.events ?? {}).map(([code, events]) => [
          StockCode.make(code),
          events,
        ])
      ),
      now: NOW,
    },
    { ...DEFAULT_SETTINGS, ...settings }
  ).pipe(Effect.map((result): Plain => result))

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
    "Special Monitoring Board and Rp1–10 codes never appear, and those above the floor are counted",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          [
            reading("BBCA", 0.3),
            reading("MAMI", 0.5),
            reading("ZINC", -0.5),
            reading("JKSW", 0.6),
            // Below the floor: never in coverage, so not counted.
            reading("BKSL", 0.2, { value: 1e6 }),
            reading("PADA", 0.2, { value: 1e6 }),
          ],
          {},
          {
            figures: {
              ZINC: { previousClose: 10 },
              // Board codes are often priced Rp1–10 too: counted once.
              MAMI: { previousClose: 8 },
              BKSL: { previousClose: 8 },
            },
            // SDPC has no readings: no book, no value, not in coverage.
            board: ["MAMI", "JKSW", "SDPC", "PADA"],
          }
        )
        assert.deepStrictEqual(result.bid, ["BBCA"])
        assert.deepStrictEqual(result.offer, [])
        assert.strictEqual(result.above, 1)
        assert.strictEqual(result.board, 2)
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

  it.effect("Lots per order ranks by the heavy side's, in either half", () =>
    Effect.gen(function* () {
      const readings = [
        // Bid-heavy: its bids' 40 count, not its offers' 1.
        reading("AAAA", 0.2, {
          bid: side(100e6, { lotsPerOrder: 40 }),
          offer: side(100e6, { lotsPerOrder: 1 }),
        }),
        reading("BBBB", 0.4, {
          bid: side(100e6, { lotsPerOrder: 20 }),
          offer: side(100e6, { lotsPerOrder: 90 }),
        }),
        // Offer-heavy: its offers' figures.
        reading("CCCC", -0.2, {
          bid: side(100e6, { lotsPerOrder: 99 }),
          offer: side(100e6, { lotsPerOrder: 5 }),
        }),
        reading("DDDD", -0.4, {
          bid: side(100e6, { lotsPerOrder: 1 }),
          offer: side(100e6, { lotsPerOrder: 15 }),
        }),
      ]
      const result = yield* run(readings, { rankBy: "lotsPerOrder" })
      assert.deepStrictEqual(
        [result.bid, result.offer],
        [
          ["AAAA", "BBBB"],
          ["DDDD", "CCCC"],
        ]
      )
      assert.strictEqual(
        yield* rankedFigure(readings[3]!, "lotsPerOrder", NOW),
        "15 lots/ord"
      )
    })
  )

  it.effect(
    "Last event ranks the newest first, a code with none last, and Events in 5 minutes the busiest",
    () =>
      Effect.gen(function* () {
        const readings = [
          reading("AAAA", 0.2),
          reading("BBBB", 0.4),
          reading("CCCC", 0.6),
          reading("DDDD", 0.8),
          reading("EEEE", -0.3),
        ]
        const events = {
          // An hour ago, and none since.
          AAAA: { last: wall("AAAA", NOW - 3_600_000), inFiveMinutes: 0 },
          BBBB: { last: wall("BBBB", NOW - 5_000), inFiveMinutes: 2 },
          CCCC: { last: wall("CCCC", NOW - 60_000), inFiveMinutes: 7 },
          EEEE: { last: wall("EEEE", NOW - 1_000), inFiveMinutes: 1 },
        }
        const ranked = (settings: Partial<RadarSettings>) =>
          Effect.map(run(readings, settings, { events }), ({ bid, offer }) => ({
            bid,
            offer,
          }))
        assert.deepStrictEqual(yield* ranked({ rankBy: "lastEvent" }), {
          bid: ["BBBB", "CCCC", "AAAA", "DDDD"],
          offer: ["EEEE"],
        })
        assert.deepStrictEqual(
          (yield* ranked({ rankBy: "lastEvent", direction: "low" })).bid,
          ["AAAA", "CCCC", "BBBB", "DDDD"]
        )
        assert.deepStrictEqual(yield* ranked({ rankBy: "eventsInFive" }), {
          bid: ["CCCC", "BBBB", "AAAA", "DDDD"],
          offer: ["EEEE"],
        })
        assert.deepStrictEqual(
          (yield* ranked({ rankBy: "eventsInFive", direction: "low" })).bid,
          // None in 5 minutes counts 0, with or without an older event.
          ["AAAA", "DDDD", "BBBB", "CCCC"]
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
        // The offer is the heavy side.
        assert.strictEqual(
          yield* rankedFigure(readings, "lotsPerOrder", NOW),
          "30 lots/ord"
        )
        assert.strictEqual(yield* rankedFigure(readings, "bookAge", NOW), "1s")
      })
  )

  it.effect("names the floor's codes and why the rest are not ranked", () =>
    Effect.gen(function* () {
      const counts = { bid: [], offer: [], limits: [] }
      assert.strictEqual(
        yield* coverageNote({ ...counts, above: 12, board: 3, cheap: 0 }),
        "12 codes above the floor · 3 Special Monitoring Board codes and 0 codes at Rp1–10 are not ranked · rows with no book change for 60 s grey out and sink"
      )
      assert.strictEqual(
        yield* coverageNote({ ...counts, above: 1, board: 1, cheap: 1 }),
        "1 code above the floor · 1 Special Monitoring Board code and 1 code at Rp1–10 are not ranked · rows with no book change for 60 s grey out and sink"
      )
    })
  )

  it.effect("shows the last event's age and the count of 5 minutes", () =>
    Effect.gen(function* () {
      const readings = reading("BBCA", 0.2)
      const events = { last: wall("BBCA", NOW - 125_000), inFiveMinutes: 3 }
      assert.strictEqual(
        yield* rankedFigure(readings, "lastEvent", NOW, events),
        "2m ago"
      )
      assert.strictEqual(
        yield* rankedFigure(readings, "eventsInFive", NOW, events),
        "3 in 5m"
      )
      assert.strictEqual(
        yield* rankedFigure(readings, "lastEvent", NOW, undefined),
        "—"
      )
      assert.strictEqual(
        yield* rankedFigure(readings, "eventsInFive", NOW, undefined),
        "0 in 5m"
      )
    })
  )
})
