// Seam (1) of spec apinrdw/kumora#263 for the one-off build of sealed days
// (ticket apinrdw/kumora#270): a day recorded and sealed through the ingest
// socket, then stripped back to what a day sealed before order flow shipped
// holds. Its object, restarted the next day, answers the footprint, sweeps and
// heatmap GETs as the day recorded with the rows did.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, type RecordedResource } from "@workspace/relay"
import { DateTime, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "@/server/market-live/day-store"
import { SEALED_CACHE } from "@/server/market-live/routes"

import { stockbitBook, stockbitTrade, tradingDay } from "./day-harness"
import { memorySql } from "./sql"

const at = (date: string, time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`${date}T${time}+07:00`))
  )
const onDay = (time: string) => at("2026-11-09", time)
const nextDay = at("2026-11-10", "10:00:00")

const UNTR = StockCode.make("UNTR")
const BBCA = StockCode.make("BBCA")

const trade = (
  number: number,
  time: string,
  code: string,
  price: number,
  lots: number,
  side?: "buy" | "sell",
  board?: "TN"
) =>
  stockbitTrade({
    number,
    time,
    code,
    price,
    lots,
    ...(side === undefined ? {} : { side }),
    ...(board === undefined ? {} : { board }),
  })

// UNTR and BBCA trading over two minutes, UNTR's book changing in them, then
// the seal.
const sealedDay = (sql: Sql) =>
  Effect.gen(function* () {
    yield* onDay("08:59:58.750")
    const day = yield* tradingDay(sql)
    yield* day.viewer("UNTR")
    yield* day.trades([
      // The opening auction's match: no side, no sweep.
      trade(30001, "08:58:00.000", "UNTR", 23300, 40),
      trade(40001, "09:00:10.100", "UNTR", 23300, 2, "buy"),
      trade(40002, "09:00:10.200", "BBCA", 8000, 7, "sell"),
      trade(40003, "09:00:10.500", "UNTR", 23325, 3, "buy"),
      trade(40004, "09:00:10.600", "UNTR", 23300, 1, "sell"),
      trade(40005, "09:00:11.000", "UNTR", 23300, 5, "sell", "TN"),
      trade(40006, "09:01:20.000", "UNTR", 23325, 4, "buy"),
      trade(40007, "09:01:20.300", "BBCA", 8025, 2, "buy"),
    ])
    yield* day.frames([
      stockbitBook({
        side: "BID",
        levels: [[23_300, 3, 50]],
        time: "08:59:58",
      }),
      stockbitBook({
        side: "OFFER",
        levels: [[23_325, 2, 40]],
        time: "08:59:58",
      }),
    ])
    yield* TestClock.adjust("250 millis")
    yield* onDay("09:00:30.750")
    yield* day.frames([
      stockbitBook({
        side: "BID",
        levels: [[23_300, 5, 90]],
        time: "09:00:30",
      }),
    ])
    yield* TestClock.adjust("250 millis")
    yield* onDay("17:00:00")
    yield* day.alarm
    yield* day.evicted
  })

const RESOURCES: ReadonlyArray<RecordedResource> = [
  { _tag: "Sweeps", code: UNTR },
  { _tag: "Candles", code: UNTR },
  { _tag: "Heatmap", code: UNTR },
  { _tag: "Sweeps", code: BBCA },
  { _tag: "Candles", code: BBCA },
]

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// Every order flow GET's Cache-Control and body, in RESOURCES' order.
const answers = (day: Day) =>
  Effect.forEach(RESOURCES, (resource) =>
    Effect.gen(function* () {
      const response = yield* day.recorded(resource)
      return [
        response.headers.get("Cache-Control"),
        yield* Effect.promise(() => response.text()),
      ]
    })
  )

// What a day sealed before order flow shipped holds: no footprint or heatmap
// table, and no mark that its rows were built.
const sealedBeforeOrderFlow = (sql: Sql) =>
  Effect.sync(() => {
    sql.exec("DROP TABLE footprints")
    sql.exec("DROP TABLE heatmaps")
    sql.exec("DELETE FROM facts WHERE key = 'order-flow-built'")
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

// The answers of the sealed day as its own object recorded them, read the
// next day.
const recordedWithRows = Effect.gen(function* () {
  const sql = memorySql()
  yield* sealedDay(sql)
  yield* nextDay
  const day = yield* tradingDay(sql)
  const answered = yield* answers(day)
  yield* day.evicted
  return answered
})

// Each test replays a day to its 17:00 seal, some twice: past Vitest's 5 s
// when the suite runs its files side by side.
const REPLAYS_A_DAY = 30_000

describe("the one-off build of a day sealed before order flow", () => {
  it.effect(
    "answers every footprint, sweeps and heatmap GET as the day recorded with the rows did, cached",
    () =>
      Effect.gen(function* () {
        const expected = yield* recordedWithRows
        assert.isTrue(expected.every(([cache]) => cache === SEALED_CACHE))
        assert.include(expected[0]![1], '"side":"buy"')
        assert.include(expected[1]![1], '"cells":[{')
        assert.include(expected[2]![1], '"levels":[[')

        const sql = memorySql()
        yield* sealedDay(sql)
        yield* sealedBeforeOrderFlow(sql)
        yield* nextDay
        const day = yield* tradingDay(sql)
        assert.deepStrictEqual(yield* answers(day), expected)
      }),
    REPLAYS_A_DAY
  )

  it.effect(
    "a second build changes nothing and writes nothing",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* sealedDay(sql)
        yield* sealedBeforeOrderFlow(sql)
        yield* nextDay
        const built = yield* answers(yield* tradingDay(sql))

        const again = watched(sql)
        const restarted = yield* tradingDay(again.sql)
        const before = again.counts.writes
        assert.deepStrictEqual(yield* answers(restarted), built)
        assert.strictEqual(again.counts.writes, before)
      }),
    REPLAYS_A_DAY
  )

  it.effect(
    "a day recorded with the rows is never built again",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* sealedDay(sql)
        yield* nextDay
        const again = watched(sql)
        const restarted = yield* tradingDay(again.sql)
        const before = again.counts.writes
        yield* answers(restarted)
        assert.strictEqual(again.counts.writes, before)
      }),
    REPLAYS_A_DAY
  )

  it.effect(
    "builds the minute of a trade stored up to a second before the first-numbered trade",
    () =>
      Effect.gen(function* () {
        // Ajaib rounds to the second: 50002 is stored a second before 50001,
        // across the minute, and the day stored no book chunk.
        const skewedDay = (sql: Sql) =>
          Effect.gen(function* () {
            yield* onDay("10:00:00.500")
            const day = yield* tradingDay(sql)
            yield* day.trades([
              trade(50001, "10:00:00.000", "UNTR", 23300, 2, "buy"),
              trade(50002, "09:59:59.000", "UNTR", 23325, 3, "sell"),
              trade(50003, "10:01:00.000", "UNTR", 23300, 4, "buy"),
            ])
            yield* onDay("17:00:00")
            yield* day.alarm
            yield* day.evicted
          })
        const untr: ReadonlyArray<RecordedResource> = [
          { _tag: "Sweeps", code: UNTR },
          { _tag: "Candles", code: UNTR },
        ]
        const bodies = (day: Day) =>
          Effect.forEach(untr, (resource) =>
            Effect.flatMap(day.recorded(resource), (response) =>
              Effect.promise(() => response.text())
            )
          )

        const recordedSql = memorySql()
        yield* skewedDay(recordedSql)
        yield* nextDay
        const recorded = yield* tradingDay(recordedSql)
        const expected = yield* bodies(recorded)
        yield* recorded.evicted
        assert.include(expected[0]!, '"side":"sell"')

        const sql = memorySql()
        yield* skewedDay(sql)
        yield* sealedBeforeOrderFlow(sql)
        yield* nextDay
        assert.deepStrictEqual(yield* bodies(yield* tradingDay(sql)), expected)
      }),
    REPLAYS_A_DAY
  )

  it.effect(
    "a build that dies halfway reruns, on the next GET, to the same answers",
    () =>
      Effect.gen(function* () {
        const expected = yield* recordedWithRows
        const sql = memorySql()
        yield* sealedDay(sql)
        yield* sealedBeforeOrderFlow(sql)
        yield* nextDay
        // The build's second transaction never lands.
        const crashing = watched(sql, 2)
        const crashed = yield* tradingDay(crashing.sql)
        const exit = yield* Effect.exit(
          crashed.recorded({ _tag: "Heatmap", code: UNTR })
        )
        assert.isTrue(Exit.isFailure(exit))

        assert.deepStrictEqual(yield* answers(yield* tradingDay(sql)), expected)
      }),
    REPLAYS_A_DAY
  )
})
