// Seam (a) of spec apinrdw/kumora#138, for the candle book's bound: a full
// day's trades go through the book with a flush each minute, and the test
// reads how many candles the book keeps and what it serves. The sweep alerts
// (spec apinrdw/kumora#510) are read the same way where a flush, a minute
// boundary or a restart sits between a sweep and its decision.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type Candle,
  type RunningTrade,
} from "@workspace/relay"
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
  lots: number,
  side: RunningTrade["side"] = "buy"
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time,
  code,
  price: 100,
  lots,
  side,
  board: "RG",
  feeds: ["Ajaib"],
})

// A flush at `at`, in epoch ms: every trade whose merge window closed by
// then is written.
const flushAt = Effect.fnUntraced(function* (
  book: Effect.Success<ReturnType<typeof makeCandleBook>>,
  store: Effect.Success<ReturnType<typeof makeDayStore>>,
  at: number
) {
  yield* TestClock.setTime(at)
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

// A flush as the trading day does it, 5 s past the minute.
const flush = (
  book: Effect.Success<ReturnType<typeof makeCandleBook>>,
  store: Effect.Success<ReturnType<typeof makeDayStore>>,
  minute: DateTime.Utc
) => flushAt(book, store, DateTime.toEpochMillis(minute) + 65_000)

describe("the candle book over a full day", () => {
  it.effect(
    "holds no more than the minute being traded, serves every candle, and adds a late trade to a stored one",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql(), { today: true })
        const book = yield* makeCandleBook(store, () => {})
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
          yield* book.takeChanged(new Set())
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
        const {
          candles: [changed],
        } = yield* book.takeChanged(new Set())
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

describe("a candle's buy value and sell value", () => {
  it.effect(
    "sum the minute's trades by aggressor side, with no-side trades in value only; an index's are 0",
    () =>
      Effect.gen(function* () {
        const store = yield* makeDayStore(memorySql(), { today: true })
        const book = yield* makeCandleBook(store, () => {})
        const minute = wib("09:00:00")
        yield* TestClock.setTime(DateTime.toEpochMillis(minute) + 10_000)
        const code = StockCode.make("BBCA")
        const at = (seconds: number) => DateTime.add(minute, { seconds })
        yield* book.trade(undefined, {
          ...tradeOf(code, 1, at(1), 2),
          side: "buy",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 2, at(2), 3),
          price: 110,
          side: "sell",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 3, at(3), 1),
          price: 105,
          side: "none",
        })
        yield* book.trade(undefined, {
          ...tradeOf(code, 4, at(4), 4),
          side: "buy",
        })
        yield* book.indexPrice({
          code: StockCode.make("COMPOSITE"),
          time: at(5),
          last: 7_000,
          volume: 1_000,
          value: 5_000_000,
          frequency: 10,
          previous: undefined,
          isIndex: true,
          high: undefined,
          low: undefined,
          open: undefined,
          change: undefined,
          changePercent: undefined,
          regularBoard: true,
        })
        const split = (candle: Candle | undefined) => ({
          value: candle?.value,
          buyValue: candle?.buyValue,
          sellValue: candle?.sellValue,
        })
        // 2 and 4 lots bought at 100, 3 sold at 110, 1 matched at 105.
        const expected = {
          value: 103_500,
          buyValue: 60_000,
          sellValue: 33_000,
        }
        const { candles } = yield* book.takeChanged(new Set())
        assert.deepStrictEqual(
          split(candles.find((candle) => candle.code === code)),
          expected
        )
        assert.deepStrictEqual(
          split(candles.find((candle) => candle.code === "COMPOSITE")),
          { value: 0, buyValue: 0, sellValue: 0 }
        )
        yield* flush(book, store, minute)
        assert.deepStrictEqual(
          split((yield* book.candlesOf(code))[0]),
          expected
        )
      })
  )
})

describe("the candle book's sweep alerts", () => {
  const UNTR = StockCode.make("UNTR")
  const BBCA = StockCode.make("BBCA")
  const at = (time: string) => DateTime.toEpochMillis(wib(time))

  // `count` one-lot UNTR buy sweeps, one a second from 09:00:00 WIB, numbered
  // from 1: its buy side's warm-up when 100.
  const warm = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      tradeOf(
        UNTR,
        index + 1,
        DateTime.add(wib("09:00:00"), { seconds: index }),
        1
      )
    )

  // A day store, and a book over it: opening a second one is a restart.
  // `alerts` hears `trades` at `time` and gives the next delta's alerts.
  const day = Effect.gen(function* () {
    const store = yield* makeDayStore(memorySql(), { today: true })
    const open = Effect.gen(function* () {
      const book = yield* makeCandleBook(store, () => {})
      const alerts = Effect.fnUntraced(function* (
        time: string,
        trades: ReadonlyArray<RunningTrade>
      ) {
        yield* TestClock.setTime(at(time))
        for (const trade of trades) yield* book.trade(undefined, trade)
        return (yield* book.takeChanged(new Set())).sweepAlerts.map((alert) => [
          alert.code,
          alert.side,
          alert.lots,
          alert.tradeNumbers,
        ])
      })
      return { book, alerts }
    })
    return { store, open }
  })

  it.effect(
    "a sweep still waiting for its second to close when a flush lets its minute go is decided once, against the sweeps before it",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const { book, alerts } = yield* open
        // 99 buy sweeps, then the 100th: its second, the latest, is open.
        assert.deepStrictEqual(
          yield* alerts("09:01:40.500", [
            ...warm(99),
            tradeOf(UNTR, 100, wib("09:01:40"), 100),
          ]),
          []
        )
        // The feed pauses past the merge window, and the flush stores the
        // minute: the book lets it go.
        yield* flushAt(book, store, at("09:01:46"))
        assert.strictEqual(yield* book.retained, 0)
        // A trade reopens the minute and closes the 100th sweep's second: it
        // had 99 before it, and stays silent.
        assert.deepStrictEqual(
          yield* alerts("09:01:47", [
            tradeOf(UNTR, 101, wib("09:01:46"), 1, "sell"),
          ]),
          []
        )
        // It ranked once. 100 sweeps cut at the largest, 100 lots, so 50
        // lots are silent; 101 cut at the 2nd largest, those 50, so 60
        // alert. Ranked twice, the 2nd largest would be 100.
        assert.deepStrictEqual(
          yield* alerts("09:01:49.500", [
            tradeOf(UNTR, 102, wib("09:01:47"), 50),
            tradeOf(UNTR, 103, wib("09:01:48"), 60),
            tradeOf(BBCA, 104, wib("09:01:49"), 1),
          ]),
          [[UNTR, "buy", 60, [TradeNumber.make("103")]]]
        )
      })
  )

  it.effect(
    "an alert decided after the book let its minute go still names the sweep's trades",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const { book, alerts } = yield* open
        assert.deepStrictEqual(
          yield* alerts("09:01:45.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 15),
            tradeOf(UNTR, 102, wib("09:01:45"), 15),
          ]),
          []
        )
        yield* flushAt(book, store, at("09:01:51"))
        assert.strictEqual(yield* book.retained, 0)
        // Another code's trade closes the sweep's second.
        assert.deepStrictEqual(
          yield* alerts("09:01:52", [tradeOf(BBCA, 103, wib("09:01:51"), 1)]),
          [
            [
              UNTR,
              "buy",
              30,
              [TradeNumber.make("101"), TradeNumber.make("102")],
            ],
          ]
        )
      })
  )

  it.effect(
    "a sweep waiting in the minute before is decided ahead of the next minute's, in trade order",
    () =>
      Effect.gen(function* () {
        const { alerts } = yield* (yield* day).open
        // The 100th buy sweep waits in 09:01's last second.
        assert.deepStrictEqual(
          yield* alerts("09:01:59.500", [
            ...warm(99),
            tradeOf(UNTR, 100, wib("09:01:59"), 1),
          ]),
          []
        )
        // One batch closes that second and the next minute's first: the big
        // sweep there has 100 before it.
        assert.deepStrictEqual(
          yield* alerts("09:02:01.500", [
            tradeOf(UNTR, 101, wib("09:02:00"), 500),
            tradeOf(UNTR, 102, wib("09:02:01"), 1, "sell"),
          ]),
          [[UNTR, "buy", 500, [TradeNumber.make("101")]]]
        )
      })
  )

  it.effect(
    "after a restart, a stored sweep timed after the newest trade heard since neither leaves the ranking nor alerts again",
    () =>
      Effect.gen(function* () {
        const { store, open } = yield* day
        const before = yield* open
        assert.deepStrictEqual(
          yield* before.alerts("09:01:46.500", [
            ...warm(100),
            tradeOf(UNTR, 101, wib("09:01:45"), 500),
            tradeOf(BBCA, 102, wib("09:01:46"), 1),
          ]),
          [[UNTR, "buy", 500, [TradeNumber.make("101")]]]
        )
        yield* flushAt(before.book, store, at("09:01:52"))

        const { book, alerts } = yield* open
        yield* book.rankStored
        // A lagging feed's trade reopens the minute, timed before the stored
        // big sweep's second.
        assert.deepStrictEqual(
          yield* alerts("09:01:53", [
            tradeOf(UNTR, 103, wib("09:01:42"), 1, "sell"),
          ]),
          []
        )
        // A later trade closes that second: the big sweep was decided before
        // the restart.
        assert.deepStrictEqual(
          yield* alerts("09:01:54", [tradeOf(BBCA, 104, wib("09:01:50"), 1)]),
          []
        )
        // It ranks once: 101 buy sweeps cut at the 2nd largest, one lot.
        // Ranked twice, they would cut at 500.
        assert.deepStrictEqual(
          yield* alerts("09:01:56.500", [
            tradeOf(UNTR, 105, wib("09:01:55"), 400),
            tradeOf(BBCA, 106, wib("09:01:56"), 1),
          ]),
          [[UNTR, "buy", 400, [TradeNumber.make("105")]]]
        )
      })
  )
})
