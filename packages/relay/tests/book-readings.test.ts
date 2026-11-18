import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import {
  StockCode,
  WibDate,
  bookReadingsOf,
  type BookLevel,
  type OrderBook,
} from "@workspace/relay"

const at = DateTime.makeUnsafe("2026-11-18T03:00:00.000Z")
const date = WibDate.make("2026-11-18")

const level = (price: number, lots: number, orders: number): BookLevel => ({
  price,
  lots,
  orders,
})

const bookOf = (
  bids: ReadonlyArray<BookLevel>,
  offers: ReadonlyArray<BookLevel>,
  previousClose?: number
): OrderBook => ({
  _tag: "OrderBook",
  code: StockCode.make("ERAA"),
  bids,
  offers,
  bidLots: bids.reduce((sum, each) => sum + each.lots, 0),
  offerLots: offers.reduce((sum, each) => sum + each.lots, 0),
  at,
  provenance: "Stockbit",
  ...(previousClose === undefined ? {} : { previousClose }),
})

const BIDS = [
  level(1000, 50, 5),
  level(995, 30, 3),
  level(985, 20, 2),
  level(980, 10, 1),
  level(970, 40, 4),
  // The sixth level counts in none of the readings.
  level(965, 990, 9),
]
const OFFERS = [level(1010, 25, 5), level(1015, 25, 1), level(1040, 50, 10)]

const read = (book: OrderBook, last?: number) =>
  bookReadingsOf(book, { date, last, value: 5e9 })

describe("book readings", () => {
  it.effect("measure each side's best five levels", () =>
    Effect.gen(function* () {
      const readings = yield* read(bookOf(BIDS, OFFERS))
      assert.deepStrictEqual(readings.bid, {
        depth: 14_815_000,
        lots: 150,
        emptyTicks: 2,
        widestGap: 1,
        lotsPerOrder: 10,
      })
      assert.deepStrictEqual(readings.offer, {
        depth: 10_262_500,
        lots: 100,
        emptyTicks: 4,
        widestGap: 4,
        lotsPerOrder: 6.25,
      })
      assert.strictEqual(readings.imbalance, 0.2)
      assert.strictEqual(readings.spread?.ticks, 2)
      assert.closeTo(readings.spread?.percent ?? 0, (10 / 1005) * 100, 1e-9)
      assert.strictEqual(readings.limit, undefined)
      assert.strictEqual(readings.code, "ERAA")
      assert.strictEqual(readings.value, 5e9)
      assert.deepStrictEqual(readings.at, at)
    })
  )

  it.effect("count a spread across a band edge on each side's tick", () =>
    Effect.gen(function* () {
      const readings = yield* read(
        bookOf([level(498, 10, 1)], [level(505, 10, 1)])
      )
      // 498 to 500 on Rp2, 500 to 505 on Rp5.
      assert.strictEqual(readings.spread?.ticks, 2)
    })
  )

  it.effect("an empty side tips imbalance whole and has no spread", () =>
    Effect.gen(function* () {
      const readings = yield* read(bookOf(BIDS, []))
      assert.strictEqual(readings.imbalance, 1)
      assert.strictEqual(readings.spread, undefined)
      assert.deepStrictEqual(readings.offer, {
        depth: 0,
        lots: 0,
        emptyTicks: 0,
        widestGap: 0,
        lotsPerOrder: undefined,
      })
      const none = yield* read(bookOf([], []))
      assert.strictEqual(none.imbalance, undefined)
    })
  )

  it.effect("flag a code at its limit: one side empty, last at the limit", () =>
    Effect.gen(function* () {
      const upper = yield* read(bookOf(BIDS, [], 1000), 1250)
      assert.strictEqual(upper.limit, "upper")
      const lower = yield* read(bookOf([], OFFERS, 1000), 930)
      assert.strictEqual(lower.limit, "lower")
      // Offers empty short of the limit, or no previous close: no flag.
      const short = yield* read(bookOf(BIDS, [], 1000), 1200)
      assert.strictEqual(short.limit, undefined)
      const unknown = yield* read(bookOf(BIDS, []), 1250)
      assert.strictEqual(unknown.limit, undefined)
    })
  )
})
