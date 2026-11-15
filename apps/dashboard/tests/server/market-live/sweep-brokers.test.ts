// The trading-day harness seam of spec apinrdw/kumora#343 for sweep brokers
// (ticket apinrdw/kumora#344): trades go in through the ingest socket, the
// day seals, broker codes batches go in as the Worker hands them over, and
// the test reads the sweep brokers GET.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  StockCode,
  TradeNumber,
  decodeSweepBrokersText,
  type RecordedResource,
  type SweepBrokers,
} from "@workspace/relay"
import { DateTime, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import { brokerPicks } from "@/lib/sweeps"
import type { Sql } from "@/server/market-live/day-store"

import {
  codesBeforeSweepBrokers,
  stockbitTrade,
  tradingDay,
  withLines,
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

  it.effect(
    "answer a sweep whose codes landed before the tape stored its trades",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:30")
        const day = yield* tradingDay()
        yield* day.trades([
          untr(1, "09:00:10.100", 3, "buy"),
          untr(2, "09:00:10.300", 5, "buy", 23325),
        ])
        yield* day.brokerCodes("Ajaib", CODES.slice(0, 2), 2)
        yield* at("17:00:00")
        yield* day.alarm
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.isTrue(answer.complete)
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), [
          [1, ["AK D 8"], ["YP D 5", "CC D 3"]],
        ])
      })
  )

  it.effect(
    "leave out a sweep a late trade without codes joins after its brokers were worked out",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:30")
        const day = yield* tradingDay()
        yield* day.trades([untr(1, "09:00:10.100", 3, "buy")])
        yield* at("09:01:10")
        yield* day.brokerCodes("Ajaib", CODES.slice(0, 1))
        yield* at("09:01:20")
        yield* day.trades([untr(2, "09:00:10.300", 5, "buy", 23325)])
        yield* at("17:00:00")
        yield* day.alarm
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), [])
      })
  )

  it.effect(
    "split a sweep a late trade without codes breaks after its brokers were worked out",
    () =>
      Effect.gen(function* () {
        yield* at("09:00:30")
        const day = yield* tradingDay()
        yield* day.trades([
          untr(1, "09:00:10.100", 3, "buy"),
          untr(3, "09:00:10.500", 5, "buy"),
        ])
        yield* at("09:01:10")
        yield* day.brokerCodes("Ajaib", [CODES[0], [3, "PD F KZ D"]])
        yield* at("09:01:20")
        yield* day.trades([untr(2, "09:00:10.300", 4, "sell")])
        yield* at("17:00:00")
        yield* day.alarm
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.map(brokersOf), [
          [1, ["AK F 3"], ["CC D 3"]],
          [3, ["PD F 5"], ["KZ D 5"]],
        ])
      })
  )

  it.effect(
    "carry a broker's lots of both investor types, so the broker filter lists it at the type of its larger lots over the sweeps",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades([
          untr(1, "09:00:10.100", 6, "buy"),
          untr(2, "09:00:10.300", 5, "buy", 23325),
          untr(3, "09:00:30.000", 7, "buy"),
        ])
        yield* at("17:00:00")
        yield* day.alarm
        yield* at("17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F CC D"],
            [2, "AK D YP D"],
            [3, "AK D CC D"],
          ],
          3
        )
        const { sweeps } = (yield* day.recordedSweeps("UNTR")).answer
        const brokers = (yield* day.recordedSweepBrokers("UNTR")).answer
        // AK swept F 6 and D 5, then D 7: D leads 12–6.
        assert.deepStrictEqual(
          yield* brokerPicks(
            sweeps,
            new Map(brokers.sweeps.map((sweep) => [sweep.firstTrade, sweep])),
            Infinity
          ),
          [{ code: BrokerCode.make("AK"), investorType: "D", lots: 18 }]
        )
        // Only a broker of both types carries its minor type's lots.
        const response = yield* day.recorded({
          _tag: "SweepBrokers",
          code: StockCode.make("UNTR"),
        })
        const text = yield* Effect.promise(() => response.text())
        assert.include(text, `[["AK","F",11,5]]`)
        assert.include(text, `[["AK","D",7]]`)
        // A row stored before both types were carried still reads.
        assert.deepStrictEqual(
          yield* decodeSweepBrokersText(`[["1",[["AK","F",11]],[]]]`),
          [
            {
              firstTrade: TradeNumber.make("1"),
              aggressor: [
                { code: BrokerCode.make("AK"), investorType: "F", lots: 11 },
              ],
              other: [],
            },
          ]
        )
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
const brokersSql = () => {
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
    "rewrite only the rows a batch changes, not every code's row of the minutes it touches",
    () =>
      Effect.gen(function* () {
        const { sql, watch } = brokersSql()
        const day = yield* sealedDay(sql)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES, 6)
        const before = watch.writes
        // BBCA's trade 3 shares 09:00 with UNTR's first sweep.
        yield* day.brokerCodes("Ajaib", [[3, "PD F KZ F"]])
        assert.strictEqual(watch.writes, before + 1)
        assert.deepStrictEqual(
          (yield* day.recordedSweepBrokers("BBCA")).answer.sweeps.map(
            brokersOf
          ),
          [[3, ["KZ F 7"], ["PD F 7"]]]
        )
      })
  )

  it.effect(
    "write no rows for a batch identical to the stored codes, from either site",
    () =>
      Effect.gen(function* () {
        const { sql, watch } = brokersSql()
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
        const { sql, watch } = brokersSql()
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

  it.effect(
    "a build cut off after a run of minutes with no whole sweep resumes past them",
    () =>
      withLines("Sweep brokers recomputed", (lines) =>
        Effect.gen(function* () {
          const sql = memorySql()
          yield* at("09:05:10")
          const sealed = yield* tradingDay(sql)
          // A whole sweep at 09:00 and at 09:04, and between them a minute
          // each of sweeps whose trades have no codes.
          yield* sealed.trades([
            untr(1, "09:00:10.000", 3, "buy"),
            untr(2, "09:00:10.200", 5, "buy", 23325),
            untr(3, "09:01:10.000", 1, "buy"),
            untr(4, "09:02:10.000", 1, "buy"),
            untr(5, "09:03:10.000", 1, "buy"),
            untr(6, "09:04:10.000", 2, "buy"),
            untr(7, "09:04:10.200", 6, "buy", 23325),
          ])
          yield* at("17:00:00")
          yield* sealed.alarm
          yield* at("17:30:00")
          yield* sealed.brokerCodes("Ajaib", [
            [1, "AK F CC D"],
            [2, "AK D YP D"],
            [6, "BK D ZP F"],
            [7, "YP D ZP F"],
          ])
          yield* sealed.evicted
          yield* codesBeforeSweepBrokers(sql)
          yield* nextDay

          // The build's 09:04 rows never land.
          const crashed = yield* tradingDay(evictedWriting(sql, "09:04:00"))
          const exit = yield* Effect.exit(crashed.recordedSweepBrokers("UNTR"))
          assert.isTrue(Exit.isFailure(exit))
          yield* crashed.evicted

          const day = yield* tradingDay(sql)
          const { answer } = yield* day.recordedSweepBrokers("UNTR")
          assert.deepStrictEqual(answer.sweeps.map(brokersOf), [
            [1, ["AK D 8"], ["YP D 5", "CC D 3"]],
            [6, ["YP D 6", "BK D 2"], ["ZP F 8"]],
          ])
          // The resumed build reads only 09:04 again.
          assert.strictEqual(lines.at(-1)!.sweepBrokerMinutes, 1)
        })
      )
  )
})

// `sql` whose transaction writing sweep brokers rows for the minute at `time`
// never lands, as an object evicted mid-build.
const evictedWriting = (sql: Sql, time: string): Sql => {
  const minute = DateTime.toEpochMillis(wib(time))
  return {
    exec: (query, ...bindings) =>
      /INTO sweep_brokers/.test(query) && bindings[1] === minute
        ? sql.exec("SELECT * FROM object_evicted_mid_build")
        : sql.exec(query, ...bindings),
    transaction: (write) => sql.transaction(write),
  }
}
