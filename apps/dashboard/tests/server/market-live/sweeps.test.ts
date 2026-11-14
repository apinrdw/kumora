// Seam (1) of spec apinrdw/kumora#263 for sweeps (ticket apinrdw/kumora#266):
// Stockbit trades go in through the ingest socket, time moves only by
// TestClock, and the test reads the sweeps GET and the deltas a page builds
// later sweeps from. The page tests join the two through the page's own sweep
// store.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumberOrder,
  decodeViewerDown,
  joinSweeps,
  sweepsOf,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeSweepStore } from "@/components/market-live/sweep-store"
import { SEALED_CACHE } from "@/server/market-live/routes"

import { ajaibTrade, stockbitTrade, sweepOf, tradingDay } from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

const untr = (
  number: number,
  time: string,
  price: number,
  lots: number,
  side?: "buy" | "sell"
) =>
  stockbitTrade({
    number,
    time,
    price,
    lots,
    ...(side === undefined ? {} : { side }),
  })

const bbca = (number: number, time: string) =>
  stockbitTrade({
    number,
    time,
    code: "BBCA",
    price: 8000,
    lots: 7,
    side: "sell",
  })

// A Market Live page on `code`: its sweep store hears what the object sends
// its socket, and the sweeps GET answers what the store asks.
const pageOn = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof tradingDay>>,
  code: string
) {
  const socket = yield* day.viewer(code)
  const store = yield* makeSweepStore(StockCode.make(code))
  let heard = 0
  let asks = 0
  // The store reads every message sent since it last heard.
  const hear = Effect.gen(function* () {
    for (const text of socket.sent.slice(heard))
      store.apply(yield* decodeViewerDown(text))
    heard = socket.sent.length
  })
  // The GET answers the store's ask now; the returned call lands the answer.
  const ask = Effect.gen(function* () {
    const asked = store.awaiting()
    assert.isDefined(asked)
    asks += 1
    const { answer } = yield* day.recordedSweeps(code)
    return () => store.answer(asked, answer)
  })
  // Hears and asks until the store has nothing left to ask.
  const settle = Effect.gen(function* () {
    yield* hear
    while (store.awaiting() !== undefined) {
      const land = yield* ask
      land()
      yield* hear
    }
  })
  return {
    hear,
    ask,
    settle,
    asks: () => asks,
    sweeps: () => store.sweeps().map(sweepOf),
  }
})

describe("sweeps", () => {
  it.effect(
    "group a code's trades by aggressor side and second: another code never breaks one, the other side or a no-side trade does, other boards don't count",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          bbca(40002, "09:00:10.200"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
          untr(40004, "09:00:10.600", 23300, 1, "sell"),
          untr(40005, "09:00:10.700", 23325, 4, "buy"),
          // No aggressor side: an auction-style print.
          untr(40006, "09:00:10.800", 23325, 5),
          untr(40007, "09:00:10.900", 23325, 6, "buy"),
          // The next second.
          untr(40008, "09:00:11.000", 23325, 1, "buy"),
          stockbitTrade({
            number: 40009,
            time: "09:00:11.200",
            price: 30000,
            lots: 500,
            side: "sell",
            board: "NG",
          }),
          untr(40010, "09:00:11.500", 23350, 2, "buy"),
        ])
        const { cacheControl, answer } = yield* day.recordedSweeps("UNTR")
        assert.strictEqual(cacheControl, "no-store")
        assert.strictEqual(answer.through, "40010")
        assert.deepStrictEqual(answer.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 5, 2],
          ["sell", "2026-11-09T02:00:10.600Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.700Z", 23325, 23325, 4, 1],
          ["none", "2026-11-09T02:00:10.800Z", 23325, 23325, 5, 1],
          ["buy", "2026-11-09T02:00:10.900Z", 23325, 23325, 6, 1],
          ["buy", "2026-11-09T02:00:11.000Z", 23325, 23350, 3, 2],
        ])
        assert.strictEqual(answer.sweeps[0]!.value, 23300 * 200 + 23325 * 300)
      })
  )

  it.effect(
    "a late trade in a minute already stored splits its sweep, served and stored rebuilt",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
          untr(40004, "09:00:30.000", 23325, 3, "sell"),
        ])
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 1, "sell")])
        const rebuilt = [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
          ["sell", "2026-11-09T02:00:30.000Z", 23325, 23325, 3, 1],
        ]
        assert.deepStrictEqual(
          (yield* day.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          rebuilt
        )
        yield* TestClock.adjust("1 minute")
        const restarted = yield* tradingDay(sql)
        assert.deepStrictEqual(
          (yield* restarted.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          rebuilt
        )
      })
  )

  it.effect(
    "a trade numbered after a minute already stored carries its last sweep on, served and stored",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:12")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40002, "09:00:10.500", 23300, 1, "sell"),
          untr(40003, "09:00:10.600", 23325, 3, "buy"),
        ])
        // Past the merge window and the minute's flush, which lets it go.
        yield* TestClock.adjust("2 minutes")
        // A second feed's late copy of the same second, numbered after.
        yield* day.trades([
          untr(40004, "09:00:10.900", 23350, 4, "buy"),
          untr(40005, "09:00:40.000", 23350, 1, "sell"),
        ])
        const carried = [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.500Z", 23300, 23300, 1, 1],
          ["buy", "2026-11-09T02:00:10.600Z", 23325, 23350, 7, 2],
          ["sell", "2026-11-09T02:00:40.000Z", 23350, 23350, 1, 1],
        ]
        assert.deepStrictEqual(
          (yield* day.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          carried
        )
        yield* TestClock.adjust("1 minute")
        const restarted = yield* tradingDay(sql)
        assert.deepStrictEqual(
          (yield* restarted.recordedSweeps("UNTR")).answer.sweeps.map(sweepOf),
          carried
        )
      })
  )

  it.effect(
    "the GET joins the delta tape with no gap or duplicate: a page grouping the trades numbered above its answer builds what a later GET answers",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* day.viewer("UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          bbca(40002, "09:00:10.200"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        // Asked before the delta carrying those trades goes out.
        const first = (yield* day.recordedSweeps("UNTR")).answer
        yield* TestClock.adjust("250 millis")
        yield* day.trades([
          // Carries the answer's last sweep on.
          untr(40004, "09:00:10.900", 23325, 1, "buy"),
          bbca(40005, "09:00:10.950"),
          untr(40006, "09:00:11.100", 23300, 4, "sell"),
        ])
        yield* TestClock.adjust("250 millis")
        const through = first.through!
        const later: Array<RunningTrade> = []
        for (const message of yield* page.received)
          if (message._tag === "Delta")
            for (const trade of message.tape)
              if (
                trade.code === "UNTR" &&
                trade.board === "RG" &&
                TradeNumberOrder(trade.tradeNumber, through) > 0
              )
                later.push(trade)
        const joined = yield* joinSweeps(first.sweeps, yield* sweepsOf(later))
        const whole = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(joined.map(sweepOf), whole.sweeps.map(sweepOf))
        assert.deepStrictEqual(whole.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 6, 3],
          ["sell", "2026-11-09T02:00:11.100Z", 23300, 23300, 4, 1],
        ])
      })
  )

  it.effect(
    "a page asks the GET once while trades only follow its answer: the delta's copies of answered trades and new trades ask nothing",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        // Answered before the delta carrying those trades goes out.
        yield* page.settle
        for (const [number, time] of [
          [40004, "09:00:10.900"],
          [40005, "09:00:11.100"],
          [40006, "09:00:11.300"],
        ] as const) {
          yield* TestClock.adjust("250 millis")
          yield* day.trades([untr(number, time, 23325, 1, "buy")])
        }
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.strictEqual(page.asks(), 1)
        assert.deepStrictEqual(page.sweeps(), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 6, 3],
          ["buy", "2026-11-09T02:00:11.100Z", 23325, 23325, 2, 2],
        ])
      })
  )

  it.effect(
    "a backfilled trade older than a full tape's oldest, which no delta's tape carries, reaches the page's sweeps",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        // A tape of newer trades evicts UNTR's two.
        for (let batch = 0; batch < 10; batch++)
          yield* day.trades(
            Array.from({ length: 1_000 }, (_, i) =>
              bbca(50001 + batch * 1_000 + i, "09:00:20.000")
            )
          )
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.deepStrictEqual(page.sweeps(), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23325, 5, 2],
        ])
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(whole.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 4, 1],
          ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
        ])
        assert.deepStrictEqual(page.sweeps(), whole.sweeps.map(sweepOf))
      }),
    60_000
  )

  it.effect(
    "a late trade that lands inside an answer still on its way to the page reaches the page's sweeps",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.trades([
          untr(40001, "09:00:10.100", 23300, 2, "buy"),
          untr(40003, "09:00:10.500", 23325, 3, "buy"),
        ])
        yield* page.hear
        // Answers through 40003, without 40002.
        const land = yield* page.ask
        yield* day.trades([untr(40002, "09:00:10.300", 23300, 4, "sell")])
        yield* TestClock.adjust("250 millis")
        // The delta carrying 40002 arrives before the answer does.
        yield* page.hear
        land()
        yield* page.settle
        const whole = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(whole.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
          ["sell", "2026-11-09T02:00:10.300Z", 23300, 23300, 4, 1],
          ["buy", "2026-11-09T02:00:10.500Z", 23325, 23325, 3, 1],
        ])
        assert.deepStrictEqual(page.sweeps(), whole.sweeps.map(sweepOf))
      })
  )

  it.effect(
    "Stockbit's time moving an answered trade Ajaib rounded into the next minute, its side unchanged, reaches the page's sweeps",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:59",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // Ajaib rounds 09:00:59.900 up.
          ajaibTrade({
            number: 40002,
            time: "09:01:00",
            price: 23300,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        // The page hears Ajaib's copies, which its answer includes.
        yield* page.settle
        assert.deepStrictEqual(page.sweeps(), [
          ["buy", "2026-11-09T02:00:59.000Z", 23300, 23300, 2, 1],
          ["buy", "2026-11-09T02:01:00.000Z", 23300, 23300, 3, 1],
        ])
        yield* day.trades([untr(40002, "09:00:59.900", 23300, 3, "buy")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        const whole = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(whole.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:59.000Z", 23300, 23300, 5, 2],
        ])
        assert.deepStrictEqual(page.sweeps(), whole.sweeps.map(sweepOf))
      })
  )

  it.effect(
    "Stockbit's time moving an answered trade to another second of its minute regroups the GET's sweeps at once, and the page's",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // Ajaib rounds 09:00:10.600 up.
          ajaibTrade({
            number: 40002,
            time: "09:00:11",
            price: 23300,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        assert.deepStrictEqual(page.sweeps(), [
          ["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 2, 1],
          ["buy", "2026-11-09T02:00:11.000Z", 23300, 23300, 3, 1],
        ])
        yield* day.trades([untr(40002, "09:00:10.600", 23300, 3, "buy")])
        yield* TestClock.adjust("250 millis")
        yield* page.settle
        // Still inside 40002's merge window.
        const whole = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(whole.sweeps.map(sweepOf), [
          ["buy", "2026-11-09T02:00:10.000Z", 23300, 23300, 5, 2],
        ])
        assert.deepStrictEqual(page.sweeps(), whole.sweeps.map(sweepOf))
      })
  )

  it.effect("a sealed day answers its sweeps whole, cached", () =>
    Effect.gen(function* () {
      yield* at("09:01:10")
      const day = yield* tradingDay()
      yield* day.trades([
        untr(40001, "09:00:10.100", 23300, 2, "buy"),
        untr(40002, "09:00:40.000", 23300, 1, "sell"),
      ])
      yield* at("17:00:00")
      yield* day.alarm
      const { cacheControl, answer } = yield* day.recordedSweeps("UNTR")
      assert.strictEqual(cacheControl, SEALED_CACHE)
      assert.strictEqual(answer.through, "40002")
      assert.deepStrictEqual(answer.sweeps.map(sweepOf), [
        ["buy", "2026-11-09T02:00:10.100Z", 23300, 23300, 2, 1],
        ["sell", "2026-11-09T02:00:40.000Z", 23300, 23300, 1, 1],
      ])
    })
  )
})
