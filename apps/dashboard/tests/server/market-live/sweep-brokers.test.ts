// The trading-day harness seam of spec apinrdw/kumora#343 for sweep brokers
// (ticket apinrdw/kumora#344): trades go in through the ingest socket, the
// day seals, broker codes batches go in as the Worker hands them over, and
// the test reads the sweep brokers GET.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  type RecordedResource,
  type SweepBrokers,
} from "@workspace/relay"
import { DateTime, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "@/server/market-live/day-store"

import {
  codesBeforeSweepBrokers,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
const nextDay = TestClock.setTime(
  DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-10T10:00:00+07:00"))
)

const untr = (
  number: number,
  time: string,
  lots: number,
  side: "buy" | "sell",
  price = 23300
) => stockbitTrade({ number, time, price, lots, side })

// UNTR's three sweeps, sealed: buys 1–2 (another code's trade 3 between
// them doesn't break it), sell 4, and buys 5–6.
const sealedDay = Effect.gen(function* () {
  yield* at("09:01:10")
  const day = yield* tradingDay()
  yield* day.trades([
    untr(1, "09:00:10.100", 3, "buy"),
    untr(2, "09:00:10.300", 5, "buy", 23325),
    stockbitTrade({
      number: 3,
      time: "09:00:10.500",
      code: "BBCA",
      price: 8000,
      lots: 7,
      side: "sell",
    }),
    untr(4, "09:00:20.000", 4, "sell"),
    untr(5, "09:00:30.000", 2, "buy"),
    untr(6, "09:00:30.200", 6, "buy"),
  ])
  yield* at("17:00:00")
  yield* day.alarm
  return day
})

// Every trade's codes, buyer then seller. AK bought 3 lots foreign, then
// 5 domestic; BK started sweep 5 but YP bought more of it.
const CODES = [
  [1, "AK F CC D"],
  [2, "AK D YP D"],
  [3, "PD F KZ D"],
  [4, "CC D AK F"],
  [5, "BK D ZP F"],
  [6, "YP D ZP F"],
] as const

// A sweep's brokers as the test compares them: first trade, then each side
// as `code type lots`.
const brokersOf = (sweep: SweepBrokers) => [
  Number(sweep.firstTrade),
  sweep.aggressor.map((b) => `${b.code} ${b.investorType} ${b.lots}`),
  sweep.other.map((b) => `${b.code} ${b.investorType} ${b.lots}`),
]

const ALL_WHOLE = [
  [1, ["AK D 8"], ["YP D 5", "CC D 3"]],
  [4, ["AK F 4"], ["CC D 4"]],
  [5, ["YP D 6", "BK D 2"], ["ZP F 8"]],
]

describe("a sealed day's sweep brokers", () => {
  it.effect(
    "answer each whole sweep with both sides' brokers in lead order, each at its larger-lot investor type",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedDay
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES, 6)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.strictEqual(answer.code, "UNTR")
        assert.isTrue(answer.complete)
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), ALL_WHOLE)
        const bbca = yield* day.recordedSweepBrokers("BBCA")
        assert.deepStrictEqual(bbca.answer.sweeps.map(brokersOf), [
          [3, ["KZ D 7"], ["PD F 7"]],
        ])
      })
  )

  it.effect(
    "leave out a sweep until every member trade has codes, from whichever batch brings them",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedDay
        yield* at("17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          CODES.filter(([number]) => number !== 2)
        )
        const partial = (yield* day.recordedSweepBrokers("UNTR")).answer
        assert.isFalse(partial.complete)
        assert.deepStrictEqual(
          partial.sweeps.map(brokersOf),
          ALL_WHOLE.slice(1)
        )
        yield* day.brokerCodes("Stockbit", [CODES[1]], 6)
        const whole = (yield* day.recordedSweepBrokers("UNTR")).answer
        assert.isTrue(whole.complete)
        assert.deepStrictEqual(whole.sweeps.map(brokersOf), ALL_WHOLE)
      })
  )

  it.effect("follow a replacement batch that changes a trade's codes", () =>
    Effect.gen(function* () {
      const day = yield* sealedDay
      yield* at("17:30:00")
      yield* day.brokerCodes("Ajaib", CODES, 6)
      yield* day.brokerCodes("Ajaib", [[6, "AK F ZP F"]])
      const { answer } = yield* day.recordedSweepBrokers("UNTR")
      assert.deepStrictEqual(answer.sweeps.map(brokersOf), [
        ...ALL_WHOLE.slice(0, 2),
        [5, ["AK F 6", "BK D 2"], ["ZP F 8"]],
      ])
    })
  )

  it.effect("answer no sweeps on a day that held codes but no tape", () =>
    Effect.gen(function* () {
      const sql = memorySql()
      yield* at("17:30:00")
      const day = yield* tradingDay(sql)
      yield* day.brokerCodes("Ajaib", CODES, 6)
      yield* day.evicted
      yield* codesBeforeSweepBrokers(sql)
      yield* nextDay
      const again = watched(sql)
      const restarted = yield* tradingDay(again.sql)
      const before = again.counts.writes
      const { answer } = yield* restarted.recordedSweepBrokers("UNTR")
      assert.deepStrictEqual(answer.sweeps, [])
      assert.strictEqual(again.counts.writes, before)
    })
  )

  it.effect("leave every other recorded day answer byte-identical", () =>
    Effect.gen(function* () {
      const day = yield* sealedDay
      const code = StockCode.make("UNTR")
      const resources: ReadonlyArray<RecordedResource> = [
        { _tag: "Codes" },
        { _tag: "Tape", at: wib("17:00:00") },
        { _tag: "Candles", code },
        { _tag: "Sweeps", code },
        { _tag: "Heatmap", code },
        { _tag: "Gaps" },
      ]
      const answers = Effect.forEach(resources, (resource) =>
        Effect.gen(function* () {
          const response = yield* day.recorded(resource)
          return {
            status: response.status,
            headers: [...response.headers.entries()],
            body: yield* Effect.promise(() => response.text()),
          }
        })
      )
      const before = yield* answers
      yield* at("17:30:00")
      yield* day.brokerCodes("Ajaib", CODES, 6)
      yield* day.brokerCodes("Ajaib", [[6, "AK F ZP F"]])
      assert.lengthOf(
        (yield* day.recordedSweepBrokers("UNTR")).answer.sweeps,
        3
      )
      assert.deepStrictEqual(yield* answers, before)
    })
  )
})

// The same trades as `sealedDay`, a sweep in each of three minutes, sealed
// with every trade's codes on `sql`, then stripped back to what a day whose
// codes landed before sweep brokers shipped holds.
const sealedBeforeSweepBrokers = (sql: Sql) =>
  Effect.gen(function* () {
    yield* at("09:03:10")
    const day = yield* tradingDay(sql)
    yield* day.trades([
      untr(1, "09:00:10.100", 3, "buy"),
      untr(2, "09:00:10.300", 5, "buy", 23325),
      stockbitTrade({
        number: 3,
        time: "09:00:10.500",
        code: "BBCA",
        price: 8000,
        lots: 7,
        side: "sell",
      }),
      untr(4, "09:01:20.000", 4, "sell"),
      untr(5, "09:02:30.000", 2, "buy"),
      untr(6, "09:02:30.200", 6, "buy"),
    ])
    yield* at("17:00:00")
    yield* day.alarm
    yield* at("17:30:00")
    yield* day.brokerCodes("Ajaib", CODES, 6)
    yield* day.evicted
    yield* codesBeforeSweepBrokers(sql)
    yield* nextDay
  })

// `sql` counting its writes. The transaction numbered `crashAt` never lands:
// SQLite fails it before it writes, as an object evicted mid-build.
const watched = (sql: Sql, crashAt = Infinity) => {
  const counts = { writes: 0, transactions: 0 }
  const watchedSql: Sql = {
    exec: (query, ...bindings) => {
      if (/^\s*(INSERT|DELETE|UPDATE|REPLACE)/i.test(query)) counts.writes++
      return sql.exec(query, ...bindings)
    },
    transaction: (write) => {
      counts.transactions++
      sql.transaction(
        counts.transactions === crashAt
          ? () => void sql.exec("SELECT * FROM object_evicted_mid_build")
          : write
      )
    },
  }
  return { sql: watchedSql, counts }
}

describe("the one-off build of a day whose codes landed before sweep brokers", () => {
  it.effect(
    "answers every whole sweep on the first GET, and builds nothing again",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* sealedBeforeSweepBrokers(sql)
        const day = yield* tradingDay(sql)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), ALL_WHOLE)
        const bbca = yield* day.recordedSweepBrokers("BBCA")
        assert.deepStrictEqual(bbca.answer.sweeps.map(brokersOf), [
          [3, ["KZ D 7"], ["PD F 7"]],
        ])
        yield* day.evicted

        const again = watched(sql)
        const restarted = yield* tradingDay(again.sql)
        const before = again.counts.writes
        const second = yield* restarted.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(second.answer.sweeps.map(brokersOf), ALL_WHOLE)
        assert.strictEqual(again.counts.writes, before)
      })
  )

  it.effect(
    "a build that dies halfway resumes, on the next GET, to the same answer",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* sealedBeforeSweepBrokers(sql)
        // The build's second minute never lands.
        const crashing = watched(sql, 2)
        const crashed = yield* tradingDay(crashing.sql)
        const exit = yield* Effect.exit(crashed.recordedSweepBrokers("UNTR"))
        assert.isTrue(Exit.isFailure(exit))
        yield* crashed.evicted

        const resumed = watched(sql)
        const day = yield* tradingDay(resumed.sql)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), ALL_WHOLE)
        // Only the two minutes after the first that landed.
        assert.strictEqual(resumed.counts.transactions, 2)
      })
  )
})
