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

import { stockbitTrade, tradingDay } from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

const untr = (
  number: number,
  time: string,
  lots: number,
  side: "buy" | "sell",
  price = 23300
) => stockbitTrade({ number, time, price, lots, side })

// UNTR's three sweeps, sealed: buys 1–2 (another code's trade 3 between
// them doesn't break it), sell 4, and buys 5–6.
const sealedDay = Effect.fnUntraced(function* (sql: Sql = memorySql()) {
  yield* at("09:01:10")
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
        const day = yield* sealedDay()
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
        const day = yield* sealedDay()
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
      const day = yield* sealedDay()
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

  it.effect("leave every other recorded day answer byte-identical", () =>
    Effect.gen(function* () {
      const day = yield* sealedDay()
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

// The day's database, counting each statement that writes the sweep brokers
// table, and failing the next `failures` of them as storage would.
const watchedSql = () => {
  const sql = memorySql()
  const watch = { writes: 0, failures: 0 }
  const exec: Sql["exec"] = (query, ...bindings) => {
    if (/^\s*(INSERT|DELETE)\b[^;]*\bsweep_brokers\b/i.test(query)) {
      if (watch.failures > 0) {
        watch.failures -= 1
        // SQLite fails it, as storage can.
        return sql.exec("SELECT * FROM storage_failed_the_write")
      }
      watch.writes += 1
    }
    return sql.exec(query, ...bindings)
  }
  return { sql: { ...sql, exec }, watch }
}

describe("a sealed day's sweep brokers while its codes arrive", () => {
  it.effect(
    "answer incomplete and uncached until the final batch, then complete and kept a minute",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedDay()
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES.slice(0, 3))
        const partial = yield* day.recordedSweepBrokers("UNTR")
        assert.isFalse(partial.answer.complete)
        assert.strictEqual(partial.cacheControl, "no-store")
        yield* day.brokerCodes("Ajaib", CODES.slice(3), 6)
        const whole = yield* day.recordedSweepBrokers("UNTR")
        assert.isTrue(whole.answer.complete)
        assert.strictEqual(whole.cacheControl, "private, max-age=60")
      })
  )

  it.effect(
    "write no rows for a batch identical to the stored codes, from either site",
    () =>
      Effect.gen(function* () {
        const { sql, watch } = watchedSql()
        const day = yield* sealedDay(sql)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES, 6)
        assert.isAbove(watch.writes, 0)
        const before = watch.writes
        yield* day.brokerCodes("Ajaib", CODES, 6)
        yield* day.brokerCodes("Stockbit", CODES, 6)
        assert.strictEqual(watch.writes, before)
        assert.deepStrictEqual(
          (yield* day.recordedSweepBrokers("UNTR")).answer.sweeps.map(
            brokersOf
          ),
          ALL_WHOLE
        )
      })
  )

  it.effect(
    "store neither the codes nor the rows when the rows fail to write, so the resent batch fills them in",
    () =>
      Effect.gen(function* () {
        const { sql, watch } = watchedSql()
        const day = yield* sealedDay(sql)
        yield* at("17:30:00")
        watch.failures = 1
        const failed = yield* Effect.exit(day.brokerCodes("Ajaib", CODES, 6))
        assert.isTrue(Exit.isFailure(failed))
        assert.isFalse(
          (yield* day.recordedSweepBrokers("UNTR")).answer.complete
        )
        yield* day.brokerCodes("Ajaib", CODES, 6)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.isTrue(answer.complete)
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), ALL_WHOLE)
      })
  )
})
