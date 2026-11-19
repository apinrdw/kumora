// The heatmap read's bound (CODING_STANDARDS.md, "Bounded memory on a
// Worker") at the busiest book a code records: a chunk in each of the day's
// 273 book minutes (day-store.ts, `heatmapOf`), a frame every 250 ms, and
// every frame changing both sides at full depth.
import { assert, describe, it } from "@effect/vitest"
import { BOOK_DEPTH, MINUTE_MS, StockCode } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeDayStore } from "@/server/market-live/day-store"

import { retainedHeap } from "../../support/retained-heap.ts"
import { memorySql } from "./sql"

const CODE = StockCode.make("BBCA")
const FIRST = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
)
const MINUTES = 273
const FRAME_MS = 250

const levels = (from: number, step: number, frame: number) =>
  Array.from({ length: BOOK_DEPTH }, (_, level) => ({
    price: from + step * level,
    lots: 1 + ((frame * 31 + level * 7) % 997),
    orders: 1 + (level % 9),
  }))

// One minute's chunk as the store keeps it: no start, then a frame every
// 250 ms, each with both sides whole.
const chunkText = (minute: number) =>
  JSON.stringify({
    code: CODE,
    minute,
    deltas: Array.from({ length: MINUTE_MS / FRAME_MS }, (_, index) => {
      const servedAt = minute + index * FRAME_MS
      return {
        servedAt,
        at: servedAt,
        provenance: "Stockbit",
        bids: levels(9_000, -25, index),
        offers: levels(9_025, 25, index),
        bidLots: 50_000,
        offerLots: 50_000,
        previousClose: 9_000,
      }
    }),
  })

describe("the heatmap read at the busiest recorded book", () => {
  it.effect(
    "keeps each minute's ending book, not its frames",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql(), { today: true })
        for (let index = 0; index < MINUTES; index++) {
          const minute = FIRST + index * MINUTE_MS
          yield* store.write({
            trades: [],
            candles: [],
            footprints: [],
            livePrices: [],
            chunks: [{ code: CODE, minute, chunk: chunkText(minute) }],
            ajaibBooks: [],
            facts: {},
          })
        }

        const before = yield* retainedHeap
        const rows = yield* store.heatmapOf(CODE)
        const held = (yield* retainedHeap) - before

        assert.strictEqual(rows.length, MINUTES)
        assert.isDefined(yield* rows.at(-1)!.endBook)
        // The rows' slices and ending books hold about 8 MB; rows that kept
        // each chunk's frames held about 220 MB, past the Worker's 128 MB.
        assert.isBelow(held, 32 * 1024 * 1024)
      }),
    { timeout: 60_000 }
  )
})
