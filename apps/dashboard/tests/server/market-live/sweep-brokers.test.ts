// The trading-day harness seam of spec apinrdw/kumora#343 for sweep brokers
// (ticket apinrdw/kumora#344): trades go in through the ingest socket, the
// day seals, broker codes batches go in as the Worker hands them over, and
// the test reads the sweep brokers GET.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  StockCode,
  decodeSweepBrokersText,
  type RecordedResource,
  type SweepBrokers,
} from "@workspace/relay"
import { DateTime, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import { brokerPicks, splitSweeps } from "@/lib/sweeps"
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
  // None for an auction match's print.
  side?: "buy" | "sell",
  price = 23300
) => stockbitTrade({ number, time, price, lots, ...(side && { side }) })

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

// A whole sweep's pieces' brokers as the test compares them: each piece's
// first trade, then each side as `code type lots`.
const brokersOf = (sweep: SweepBrokers) =>
  sweep.pieces.map((piece) => [
    Number(piece.firstTrade),
    piece.aggressor.map((b) => `${b.code} ${b.investorType} ${b.lots}`),
    piece.other.map((b) => `${b.code} ${b.investorType} ${b.lots}`),
  ])

// Sweep 5's aggressors BK and YP make a piece each.
const ALL_WHOLE = [
  [1, ["AK D 8"], ["YP D 5", "CC D 3"]],
  [4, ["AK F 4"], ["CC D 4"]],
  [5, ["BK D 2"], ["ZP F 2"]],
  [6, ["YP D 6"], ["ZP F 6"]],
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), ALL_WHOLE)
        const bbca = yield* day.recordedSweepBrokers("BBCA")
        assert.deepStrictEqual(bbca.answer.sweeps.flatMap(brokersOf), [
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
          partial.sweeps.flatMap(brokersOf),
          ALL_WHOLE.slice(1)
        )
        yield* day.brokerCodes("Stockbit", [CODES[1]], 6)
        const whole = (yield* day.recordedSweepBrokers("UNTR")).answer
        assert.isTrue(whole.complete)
        assert.deepStrictEqual(whole.sweeps.flatMap(brokersOf), ALL_WHOLE)
      })
  )

  it.effect("follow a replacement batch that changes a trade's codes", () =>
    Effect.gen(function* () {
      const day = yield* sealedDay()
      yield* at("17:30:00")
      yield* day.brokerCodes("Ajaib", CODES, 6)
      yield* day.brokerCodes("Ajaib", [[6, "AK F ZP F"]])
      const { answer } = yield* day.recordedSweepBrokers("UNTR")
      assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [
        ...ALL_WHOLE.slice(0, 3),
        [6, ["AK F 6"], ["ZP F 6"]],
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [])
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [
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
        const split = yield* splitSweeps(
          sweeps,
          new Map(brokers.sweeps.map((sweep) => [sweep.firstTrade, sweep]))
        )
        assert.deepStrictEqual(
          yield* brokerPicks(split.sweeps, split.pieces, Infinity),
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
      })
  )

  it.effect(
    "answer an auction match whose trades all have codes with its buyers as `aggressor` and its sellers as `other`, and none with a trade uncoded",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        // The opening match: UNTR's three prints, then BBCA's two, in a
        // minute that holds no sweep. A sweep of UNTR follows at 09:00.
        yield* day.trades([
          untr(1, "08:58:00.000", 3),
          untr(2, "08:58:00.000", 5),
          untr(3, "08:58:00.000", 4),
          stockbitTrade({
            number: 4,
            time: "08:58:00.000",
            code: "BBCA",
            price: 8000,
            lots: 7,
          }),
          stockbitTrade({
            number: 5,
            time: "08:58:00.000",
            code: "BBCA",
            price: 8000,
            lots: 2,
          }),
          untr(6, "09:00:10.000", 6, "buy"),
        ])
        yield* at("17:00:00")
        yield* day.alarm
        yield* at("17:30:00")
        const { sweeps } = (yield* day.recordedSweeps("UNTR")).answer
        assert.deepStrictEqual(
          sweeps.map((sweep) => [sweep.side, sweep.trades]),
          [
            ["none", 3],
            ["buy", 1],
          ]
        )
        // BBCA's trade 5 has no codes yet.
        yield* day.brokerCodes("Ajaib", [
          [1, "AK F CC D"],
          [2, "YP D CC D"],
          [3, "AK F KZ F"],
          [4, "PD F KZ D"],
          [6, "BK D ZP F"],
        ])
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [
          [1, ["AK F 7", "YP D 5"], ["CC D 8", "KZ F 4"]],
          [6, ["BK D 6"], ["ZP F 6"]],
        ])
        // The match is never split: one piece, the whole match.
        const [match] = answer.sweeps
        assert.lengthOf(match!.pieces, 1)
        assert.deepStrictEqual(
          [match!.pieces[0]!.side, match!.pieces[0]!.lots],
          ["none", 12]
        )
        assert.deepStrictEqual(
          (yield* day.recordedSweepBrokers("BBCA")).answer.sweeps,
          []
        )
        yield* day.brokerCodes("Ajaib", [[5, "AK F KZ D"]])
        assert.deepStrictEqual(
          (yield* day.recordedSweepBrokers("BBCA")).answer.sweeps.flatMap(
            brokersOf
          ),
          [[4, ["PD F 7", "AK F 2"], ["KZ D 9"]]]
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
      // Its build writes only the finished mark, and once.
      assert.strictEqual(again.counts.writes, before + 1)
      yield* restarted.recordedSweepBrokers("UNTR")
      assert.strictEqual(again.counts.writes, before + 1)
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

// A piece's sweep fields as the test compares them: side, first trade,
// time, first and last price, lots, value and trade count.
const fieldsOf = (piece: SweepBrokers["pieces"][number]) => [
  piece.side,
  Number(piece.firstTrade),
  DateTime.formatIso(piece.time),
  piece.first,
  piece.last,
  piece.lots,
  piece.value,
  piece.trades,
]

describe("a sealed day's whole sweeps split per aggressor broker", () => {
  it.effect(
    "make one piece per seller in a second, each with its own fields and the buyers its trades met, FZ's interleaved trades one piece",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        // One sell sweep: FZ, XL, FZ, FZ.
        yield* day.trades([
          untr(1, "09:00:20.100", 10, "sell", 23300),
          untr(2, "09:00:20.200", 4, "sell", 23275),
          untr(3, "09:00:20.300", 5, "sell", 23275),
          untr(4, "09:00:20.400", 1, "sell", 23250),
        ])
        yield* at("17:00:00")
        yield* day.alarm
        yield* at("17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F FZ D"],
            [2, "CC D XL D"],
            [3, "YP D FZ D"],
            [4, "AK D FZ F"],
          ],
          4
        )
        const { sweeps } = (yield* day.recordedSweeps("UNTR")).answer
        assert.lengthOf(sweeps, 1)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(
          answer.sweeps.map((sweep) => Number(sweep.firstTrade)),
          [1]
        )
        const [whole] = answer.sweeps
        assert.deepStrictEqual(whole!.pieces.map(fieldsOf), [
          [
            "sell",
            1,
            "2026-11-09T02:00:20.100Z",
            23300,
            23250,
            16,
            23300 * 1000 + 23275 * 500 + 23250 * 100,
            3,
          ],
          [
            "sell",
            2,
            "2026-11-09T02:00:20.200Z",
            23275,
            23275,
            4,
            23275 * 400,
            1,
          ],
        ])
        assert.deepStrictEqual(brokersOf(whole!), [
          [1, ["FZ D 16"], ["AK F 11", "YP D 5"]],
          [2, ["XL D 4"], ["CC D 4"]],
        ])
      })
  )

  it.effect("make one broker's sells in two seconds two sweeps", () =>
    Effect.gen(function* () {
      yield* at("09:01:10")
      const day = yield* tradingDay()
      yield* day.trades([
        untr(1, "09:00:20.100", 10, "sell"),
        untr(2, "09:00:21.100", 4, "sell"),
      ])
      yield* at("17:00:00")
      yield* day.alarm
      yield* at("17:30:00")
      yield* day.brokerCodes(
        "Ajaib",
        [
          [1, "AK F FZ D"],
          [2, "CC D FZ D"],
        ],
        2
      )
      const { answer } = yield* day.recordedSweepBrokers("UNTR")
      assert.deepStrictEqual(answer.sweeps.map(brokersOf), [
        [[1, ["FZ D 10"], ["AK F 10"]]],
        [[2, ["FZ D 4"], ["CC D 4"]]],
      ])
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
          (yield* day.recordedSweepBrokers("BBCA")).answer.sweeps.flatMap(
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
          (yield* day.recordedSweepBrokers("UNTR")).answer.sweeps.flatMap(
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), ALL_WHOLE)
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), ALL_WHOLE)
        const bbca = yield* day.recordedSweepBrokers("BBCA")
        assert.deepStrictEqual(bbca.answer.sweeps.flatMap(brokersOf), [
          [3, ["KZ D 7"], ["PD F 7"]],
        ])
        yield* day.evicted

        const again = watched(sql)
        const restarted = yield* tradingDay(again.sql)
        const before = again.counts.writes
        const second = yield* restarted.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(
          second.answer.sweeps.flatMap(brokersOf),
          ALL_WHOLE
        )
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
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), ALL_WHOLE)
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
          assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), [
            [1, ["AK D 8"], ["YP D 5", "CC D 3"]],
            [6, ["BK D 2"], ["ZP F 2"]],
            [7, ["YP D 6"], ["ZP F 6"]],
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

// What a day built under an older finished value holds: every row in the
// shape before pieces, and the build marked with that value; under `built`,
// from before auction matches had their entry, no auction-only row.
const builtUnder = (value: "built" | "built-auctions") => (sql: Sql) =>
  Effect.sync(() => {
    if (value === "built")
      sql.exec(
        "DELETE FROM sweep_brokers WHERE minute = ?",
        DateTime.toEpochMillis(wib("08:58:00"))
      )
    sql.exec(
      "UPDATE sweep_brokers SET sweeps = ?",
      `[["3",[["BK","D",6]],[["ZP","F",6]]]]`
    )
    sql.exec(
      "UPDATE facts SET value = ? WHERE key = 'sweep-brokers-built'",
      value
    )
  })

// Whether every stored row reads in the current shape.
const rowsRead = (sql: Sql) =>
  Effect.forEach(sql.exec("SELECT sweeps FROM sweep_brokers"), (row) =>
    decodeSweepBrokersText(String(row.sweeps))
  )

// UNTR's opening match at 08:58 and a buy sweep at 09:00.
const OPENING_AND_SWEEP = [
  untr(1, "08:58:00.000", 3),
  untr(2, "08:58:00.000", 5),
  untr(3, "09:00:10.000", 6, "buy"),
]
const OPENING_CODES = [
  [1, "AK F CC D"],
  [2, "YP D KZ F"],
  [3, "BK D ZP F"],
] as const
const WITH_AUCTION = [
  [1, ["YP D 5", "AK F 3"], ["KZ F 5", "CC D 3"]],
  [3, ["BK D 6"], ["ZP F 6"]],
]

for (const [value, until] of [
  ["built", "before auction matches had their entry"],
  ["built-auctions", "before whole sweeps split"],
] as const)
  describe(`a day whose sweep brokers were built ${until}`, () => {
    it.effect(
      "rebuilds on its next GET with no old-shape row left, logs the build, and leaves every other answer byte-identical",
      () =>
        withLines("Sweep brokers recomputed", (lines) =>
          Effect.gen(function* () {
            const sql = memorySql()
            yield* at("09:01:10")
            const sealed = yield* tradingDay(sql)
            yield* sealed.trades(OPENING_AND_SWEEP)
            yield* at("17:00:00")
            yield* sealed.alarm
            yield* at("17:30:00")
            yield* sealed.brokerCodes("Ajaib", OPENING_CODES, 3)
            yield* sealed.evicted
            yield* builtUnder(value)(sql)
            yield* nextDay

            const day = yield* tradingDay(sql)
            const code = StockCode.make("UNTR")
            const resources: ReadonlyArray<RecordedResource> = [
              { _tag: "Codes" },
              { _tag: "Tape", at: wib("17:00:00") },
              { _tag: "BrokerCodes", at: wib("17:00:00") },
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
            const logged = lines.length
            const { answer } = yield* day.recordedSweepBrokers("UNTR")
            assert.deepStrictEqual(
              answer.sweeps.flatMap(brokersOf),
              WITH_AUCTION
            )
            assert.deepStrictEqual(yield* answers, before)
            yield* rowsRead(sql)
            // The build read the day's minutes, 08:57 to 09:00 with the
            // trades' skew, and wrote both rows.
            assert.lengthOf(lines, logged + 1)
            assert.strictEqual(lines.at(-1)!.sweepBrokerMinutes, 4)
            assert.strictEqual(lines.at(-1)!.sweepBrokers, 2)
            // And builds nothing again.
            yield* day.evicted
            const again = watched(sql)
            const restarted = yield* tradingDay(again.sql)
            const writes = again.counts.writes
            yield* restarted.recordedSweepBrokers("UNTR")
            assert.strictEqual(again.counts.writes, writes)
          })
        )
    )

    it.effect(
      "rebuilds from its first minute though a late trade lands before the seal",
      () =>
        Effect.gen(function* () {
          const sql = memorySql()
          yield* at("09:01:10")
          const live = yield* tradingDay(sql)
          yield* live.trades(OPENING_AND_SWEEP)
          // Past the 09:02 flush, so the trades are stored.
          yield* at("09:02:10")
          yield* live.brokerCodes("Ajaib", OPENING_CODES)
          yield* live.evicted
          yield* builtUnder(value)(sql)

          yield* at("09:02:20")
          const day = yield* tradingDay(sql)
          yield* day.trades([untr(4, "09:00:40.000", 2, "sell")])
          yield* at("17:00:00")
          yield* day.alarm
          const { answer } = yield* day.recordedSweepBrokers("UNTR")
          assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), WITH_AUCTION)
        })
    )

    it.effect("rebuilds on a GET before the seal", () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("09:01:10")
        const live = yield* tradingDay(sql)
        yield* live.trades(OPENING_AND_SWEEP)
        yield* at("09:02:10")
        yield* live.brokerCodes("Ajaib", OPENING_CODES)
        yield* live.evicted
        yield* builtUnder(value)(sql)

        yield* at("09:02:20")
        const day = yield* tradingDay(sql)
        const { answer } = yield* day.recordedSweepBrokers("UNTR")
        assert.deepStrictEqual(answer.sweeps.flatMap(brokersOf), WITH_AUCTION)
        yield* rowsRead(sql)
      })
    )
  })
