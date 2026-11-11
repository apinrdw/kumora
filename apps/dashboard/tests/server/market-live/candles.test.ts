// Seam (a) of spec apinrdw/kumora#138, for the candle book's bound: a full
// day's trades go through the book with a flush each minute, and the test
// reads how many candles the book keeps and what it serves.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, TradeNumber, type RunningTrade } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeCandleBook } from "@/server/market-live/candles"
import { makeDayStore } from "@/server/market-live/day-store"

import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)

const codes = Array.from({ length: FULL_DAY_CODES }, (_, index) =>
  StockCode.make(`C${String(index).padStart(3, "0")}`)
)

const tradeOf = (
  code: StockCode,
  number: number,
  time: DateTime.Utc,
  lots: number
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time,
  code,
  price: 100,
  lots,
  side: "buy",
  board: "RG",
  feeds: ["Ajaib"],
})

// A flush as the trading day does it, 5 s past the minute.
const flush = Effect.fnUntraced(function* (
  book: Effect.Success<ReturnType<typeof makeCandleBook>>,
  store: Effect.Success<ReturnType<typeof makeDayStore>>,
  minute: DateTime.Utc
) {
  yield* TestClock.setTime(DateTime.toEpochMillis(minute) + 65_000)
  const settled = yield* book.takeSettled(false)
  yield* store.write({
    ...settled,
    livePrices: [],
    chunks: [],
    ajaibBooks: [],
    facts: {},
  })
  yield* book.written
})

describe("the candle book over a full day", () => {
  it.effect(
    "holds no more than the minute being traded, serves every candle, and adds a late trade to a stored one",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql())
        const book = yield* makeCandleBook(store)
        const first = wib("08:58:00")
        let number = 0
        let most = 0
        // Every code trades once a minute; a delta takes the changes, and a
        // flush writes the minute, as the trading day does.
        for (let index = 0; index < FULL_DAY_MINUTES; index++) {
          const minute = DateTime.add(first, { minutes: index })
          yield* TestClock.setTime(DateTime.toEpochMillis(minute) + 10_000)
          for (const code of codes)
            yield* book.trade(
              undefined,
              tradeOf(code, ++number, DateTime.add(minute, { seconds: 10 }), 1)
            )
          yield* book.takeChanged
          most = Math.max(most, yield* book.retained)
          yield* flush(book, store, minute)
        }
        // The open minute's candles, one per code.
        assert.isAtMost(most, FULL_DAY_CODES)
        assert.strictEqual(yield* book.retained, 0)
        const candles = yield* book.candlesOf(codes[0]!)
        assert.lengthOf(candles, FULL_DAY_MINUTES)
        assert.strictEqual(
          DateTime.formatIso(candles[0]!.minute),
          DateTime.formatIso(first)
        )
        assert.deepStrictEqual(
          candles.map((candle) => candle.frequency),
          Array.from({ length: FULL_DAY_MINUTES }, () => 1)
        )
        const later = yield* book.foldAfter(
          codes.at(-1)!,
          DateTime.toEpochMillis(first)
        )
        assert.strictEqual(later?.frequency, FULL_DAY_MINUTES - 1)
        assert.strictEqual(
          later?.closeTime,
          DateTime.toEpochMillis(wib("16:15:10"))
        )

        const late = tradeOf(
          codes[0]!,
          number + 1,
          DateTime.add(first, { seconds: 40 }),
          3
        )
        yield* book.trade(undefined, late)
        const [changed] = yield* book.takeChanged
        assert.deepStrictEqual(
          { volume: changed?.volume, frequency: changed?.frequency },
          { volume: 4, frequency: 2 }
        )
        yield* TestClock.adjust("6 seconds")
        const settled = yield* book.takeSettled(false)
        yield* store.write({
          ...settled,
          livePrices: [],
          chunks: [],
          ajaibBooks: [],
          facts: {},
        })
        yield* book.written
        assert.strictEqual(yield* book.retained, 0)
        const [stored] = yield* store.storedCandlesOf(codes[0]!)
        assert.deepStrictEqual(
          {
            volume: stored?.figures.volume,
            frequency: stored?.figures.frequency,
          },
          { volume: 4, frequency: 2 }
        )
        assert.strictEqual((yield* book.candlesOf(codes[0]!))[0]?.volume, 4)
      }),
    { timeout: 120_000 }
  )
})
