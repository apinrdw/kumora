import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"

import {
  StockCode,
  bookReadingsOf,
  fillEstimateOf,
  limitOf,
  type BookLevel,
  type OrderBook,
} from "@workspace/relay"

const at = DateTime.makeUnsafe("2026-11-18T03:00:00.000Z")

const level = (price: number, lots: number, orders: number): BookLevel => ({
  price,
  lots,
  orders,
})

const bookOf = (
  bids: ReadonlyArray<BookLevel>,
  offers: ReadonlyArray<BookLevel>,
  previousClose?: number,
  code = "ERAA"
): OrderBook => ({
  _tag: "OrderBook",
  code: StockCode.make(code),
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

const read = bookReadingsOf

// The limit mark of `book`'s readings at `last`, against the book's previous
// close.
const limitAt = (book: OrderBook, last?: number) =>
  Effect.flatMap(bookReadingsOf(book), (readings) =>
    limitOf(readings, { last, previousClose: book.previousClose })
  )

describe("book readings", () => {
  it.effect("measure each side's best five levels", () =>
    Effect.gen(function* () {
      const readings = yield* read(bookOf(BIDS, OFFERS))
      assert.deepStrictEqual(readings.bid, {
        nearDepth: 14_815_000,
        lots: 150,
        emptyTicks: 2,
        widestGap: 1,
        lotsPerOrder: 10,
      })
      assert.deepStrictEqual(readings.offer, {
        nearDepth: 10_262_500,
        lots: 100,
        emptyTicks: 4,
        widestGap: 4,
        lotsPerOrder: 6.25,
      })
      assert.strictEqual(readings.imbalance, 0.2)
      assert.strictEqual(readings.spread?.ticks, 2)
      assert.closeTo(readings.spread?.percent ?? 0, (10 / 1005) * 100, 1e-9)
      assert.strictEqual(readings.code, "ERAA")
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
        nearDepth: 0,
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
      assert.strictEqual(yield* limitAt(bookOf(BIDS, [], 1000), 1250), "upper")
      assert.strictEqual(yield* limitAt(bookOf([], OFFERS, 1000), 930), "lower")
      // Offers empty short of the limit, or no previous close: no flag.
      assert.strictEqual(
        yield* limitAt(bookOf(BIDS, [], 1000), 1200),
        undefined
      )
      assert.strictEqual(yield* limitAt(bookOf(BIDS, []), 1250), undefined)
      assert.strictEqual(
        yield* limitAt(bookOf(BIDS, OFFERS, 1000), 1250),
        undefined,
        "both sides quoted: no limit queue"
      )
    })
  )

  it.effect(
    "flag a warrant at its own limit and a right only at the Rp1 floor",
    () =>
      Effect.gen(function* () {
        const warrant = (bids: ReadonlyArray<BookLevel>, last: number) =>
          limitAt(
            bookOf(bids, bids.length === 0 ? OFFERS : [], 100, "ERAA-W"),
            last
          )
        assert.strictEqual(
          yield* warrant(BIDS, 140),
          undefined,
          "a warrant at Rp100 moves 50%: Rp140 is short of its upper limit"
        )
        assert.strictEqual(yield* warrant(BIDS, 150), "upper")
        assert.strictEqual(yield* warrant([], 50), "lower")
        const right = (bids: ReadonlyArray<BookLevel>, last: number) =>
          limitAt(
            bookOf(bids, bids.length === 0 ? OFFERS : [], 100, "ERAA-R"),
            last
          )
        assert.strictEqual(
          yield* right(BIDS, 1_000),
          undefined,
          "a right has no upper limit"
        )
        assert.strictEqual(yield* right([], 50), undefined)
        assert.strictEqual(yield* right([], 1), "lower")
      })
  )
})

describe("fill estimate", () => {
  const book = bookOf(BIDS, OFFERS)

  it.effect("a buy inside the best offer fills there, with no slippage", () =>
    Effect.gen(function* () {
      const fill = yield* fillEstimateOf(book, "buy", {
        unit: "lots",
        amount: 10,
      })
      assert.deepStrictEqual(fill, {
        levels: 1,
        last: 1010,
        average: 1010,
        slippage: { ticks: 0, percent: 0 },
        lots: 10,
        rupiah: 1_010_000,
        short: false,
      })
    })
  )

  it.effect(
    "a buy across three offers averages them and reaches the third",
    () =>
      Effect.gen(function* () {
        const fill = yield* fillEstimateOf(book, "buy", {
          unit: "lots",
          amount: 60,
        })
        // 25 at 1010, 25 at 1015 and 10 at 1040: 1040 is 6 ticks of Rp5 above
        // 1010, and the average 1017.08 is 0.70% above it.
        assert.strictEqual(fill?.levels, 3)
        assert.strictEqual(fill?.last, 1040)
        assert.strictEqual(fill?.lots, 60)
        assert.strictEqual(fill?.rupiah, 6_102_500)
        assert.closeTo(fill?.average ?? 0, 1017.083, 0.001)
        assert.strictEqual(fill?.slippage.ticks, 6)
        assert.closeTo(fill?.slippage.percent ?? 0, 0.7013, 0.0001)
        assert.isFalse(fill?.short)
      })
  )

  it.effect("a sell in rupiah walks the bids in whole lots", () =>
    Effect.gen(function* () {
      const fill = yield* fillEstimateOf(book, "sell", {
        unit: "rupiah",
        amount: 6_500_000,
      })
      // 50 lots at 1000 (Rp5,000,000), then 15 at 995 (Rp1,492,500); the
      // Rp7,500 left can't sell another lot.
      assert.strictEqual(fill?.levels, 2)
      assert.strictEqual(fill?.last, 995)
      assert.strictEqual(fill?.lots, 65)
      assert.strictEqual(fill?.rupiah, 6_492_500)
      assert.closeTo(fill?.average ?? 0, 998.846, 0.001)
      assert.strictEqual(fill?.slippage.ticks, 1)
      assert.closeTo(fill?.slippage.percent ?? 0, 0.1154, 0.0001)
      assert.isFalse(fill?.short)
    })
  )

  it.effect("a size past the levels shown says what they cover", () =>
    Effect.gen(function* () {
      const twenty = Array.from({ length: 20 }, (_, index) =>
        level(1000 + index * 5, 10, 1)
      )
      const fill = yield* fillEstimateOf(bookOf(BIDS, twenty), "buy", {
        unit: "lots",
        amount: 500,
      })
      // 10 lots at each of 1000, 1005 ... 1095.
      assert.strictEqual(fill?.levels, 20)
      assert.strictEqual(fill?.last, 1095)
      assert.strictEqual(fill?.lots, 200)
      assert.strictEqual(fill?.rupiah, 20_950_000)
      assert.strictEqual(fill?.slippage.ticks, 19)
      assert.isTrue(fill?.short)
      const rupiah = yield* fillEstimateOf(bookOf(BIDS, twenty), "buy", {
        unit: "rupiah",
        amount: 1e9,
      })
      assert.isTrue(rupiah?.short)
      assert.strictEqual(rupiah?.rupiah, 20_950_000)
    })
  )

  it.effect("an empty side, or a size short of one lot, fills nothing", () =>
    Effect.gen(function* () {
      const empty = yield* fillEstimateOf(bookOf(BIDS, []), "buy", {
        unit: "lots",
        amount: 10,
      })
      assert.strictEqual(empty, undefined)
      const small = yield* fillEstimateOf(book, "buy", {
        unit: "rupiah",
        amount: 100_000,
      })
      assert.strictEqual(small, undefined)
    })
  )
})
