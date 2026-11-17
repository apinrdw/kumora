// Spec apinrdw/kumora#437, "Dashboard: TradingDay" (The build, When it
// runs): a complete sealed day's broker totals and candles, built on the
// trading day's alarm into the memory broker totals DB and read back by
// range.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  decodeBrokerCodesStatus,
  StockCode,
  WibDate,
  type RunningTrade,
  type TradeFields,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { expectTypeOf } from "vitest"

import { readBrokerTotals } from "@/server/broker-totals/db"
import type { BrokerCodesStore } from "@/server/market-live/broker-codes"
import type { Sql } from "@/server/market-live/day-store"
import { BROKER_TOTALS_VERSION } from "@/server/market-live/broker-totals"

import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db"
import { stockbitTrade, tradingDay, withLines } from "./day-harness"
import { memorySql } from "./sql"

const DAY = WibDate.make("2026-11-09")
const UNTR = StockCode.make("UNTR")
const BBCA = StockCode.make("BBCA")
const wib = (time: string) => DateTime.makeUnsafe(`${DAY}T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

// The tape: an opening auction match, regular trades of UNTR and BBCA, and
// UNTR on the negotiated (4) and cash (5) boards. Trade 7 is a tape hole.
const TAPE = [
  stockbitTrade({ number: 1, time: "08:58:00.000", price: 23_000, lots: 10 }),
  stockbitTrade({
    number: 2,
    time: "09:00:10.000",
    price: 23_300,
    lots: 3,
    side: "buy",
  }),
  stockbitTrade({
    number: 3,
    time: "09:00:10.500",
    code: "BBCA",
    price: 8_000,
    lots: 7,
    side: "sell",
  }),
  stockbitTrade({
    number: 4,
    time: "09:00:20.000",
    price: 23_500,
    lots: 100,
    board: "NG",
  }),
  stockbitTrade({
    number: 5,
    time: "09:00:30.000",
    price: 23_200,
    lots: 50,
    side: "buy",
    board: "TN",
  }),
  stockbitTrade({
    number: 6,
    time: "09:00:40.000",
    price: 23_400,
    lots: 2,
    side: "sell",
  }),
]

// The walk's fields of the tape hole.
const WALKED: TradeFields = {
  time: wib("09:00:35.000"),
  code: UNTR,
  price: 23_100,
  lots: 4,
  board: "RG",
  side: "buy",
}

// Each trade's codes, buyer then seller.
const CODES = [
  [1, "AK F CC D"],
  [2, "AK D YP D"],
  [3, "PD F KZ D"],
  [4, "AK D CC D"],
  [5, "AK D CC D"],
  [6, "YP D AK F"],
  [7, "AK F YP D", WALKED],
] as const

const untrTotal = (
  broker: string,
  investorType: "D" | "F",
  [buyLots, buyValue, sellLots, sellValue]: readonly [
    number,
    number,
    number,
    number,
  ]
) => ({
  day: DAY,
  broker: BrokerCode.make(broker),
  investorType,
  buyLots,
  buyValue,
  sellLots,
  sellValue,
})

// UNTR's regular board and auction match: trades 1, 2, 6 and the walked 7.
const UNTR_BUILT = {
  builtDays: [
    {
      day: DAY,
      buildVersion: BROKER_TOTALS_VERSION,
      builtAt: "2026-11-09T10:30:00.000Z",
      missingTrades: 0,
    },
  ],
  candles: [
    {
      day: DAY,
      open: 23_000,
      high: 23_400,
      low: 23_000,
      close: 23_100,
      volume: 19,
      value: 43_910_000,
      trades: 4,
    },
  ],
  totals: [
    untrTotal("AK", "D", [3, 6_990_000, 0, 0]),
    untrTotal("AK", "F", [14, 32_240_000, 2, 4_680_000]),
    untrTotal("CC", "D", [0, 0, 10, 23_000_000]),
    untrTotal("YP", "D", [2, 4_680_000, 7, 16_230_000]),
  ],
}

const read = (db: ReturnType<typeof memoryBrokerTotalsDb>, code: StockCode) =>
  readBrokerTotals(code, DAY, DAY).pipe(Effect.provide(db.layer))

const NOTHING = { builtDays: [], candles: [], totals: [] }

// The tape recorded by 09:01:10 and sealed at 17:00.
const sealedDay = Effect.fnUntraced(function* (
  db: ReturnType<typeof memoryBrokerTotalsDb>,
  sql = memorySql()
) {
  yield* at("09:01:10")
  const day = yield* tradingDay(sql, [], db.layer)
  yield* day.trades(TAPE)
  yield* at("17:00:00")
  yield* day.alarm
  return day
})

describe("a complete sealed day's broker totals", () => {
  it.effect(
    "build on the alarm the completing batch arms, auction matches and walk-filled trades counted, NG and TN left out",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* sealedDay(db)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES.slice(0, 6), 7)
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)

        const armed = day.alarms.length
        yield* day.brokerCodes("Stockbit", CODES.slice(6))
        assert.deepStrictEqual(day.alarms.slice(armed), [wib("17:30:00")])
        // The batch's answer came before any build.
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)

        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
        assert.deepStrictEqual(yield* read(db, BBCA), {
          builtDays: UNTR_BUILT.builtDays,
          candles: [
            {
              day: DAY,
              open: 8_000,
              high: 8_000,
              low: 8_000,
              close: 8_000,
              volume: 7,
              value: 5_600_000,
              trades: 1,
            },
          ],
          totals: [
            {
              day: DAY,
              broker: BrokerCode.make("KZ"),
              investorType: "D",
              buyLots: 0,
              buyValue: 0,
              sellLots: 7,
              sellValue: 5_600_000,
            },
            {
              day: DAY,
              broker: BrokerCode.make("PD"),
              investorType: "F",
              buyLots: 7,
              buyValue: 5_600_000,
              sellLots: 0,
              sellValue: 0,
            },
          ],
        })
      })
  )

  it.effect(
    "of a day complete before 17:00 build only after its seal, its batch arming no build",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        yield* at("09:01:10")
        const day = yield* tradingDay(memorySql(), [], db.layer)
        yield* day.trades(TAPE)
        yield* at("16:00:00")
        yield* day.brokerCodes("Ajaib", CODES, 7)
        assert.isFalse(
          day.alarms.some((alarm) =>
            DateTime.isLessThan(alarm, wib("17:00:00"))
          )
        )
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)

        yield* at("17:30:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
      })
  )

  it.effect("of a day with no relay tape build in its seal's wake", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      yield* at("17:30:00")
      const day = yield* tradingDay(memorySql(), [], db.layer)
      yield* day.brokerCodes(
        "Stockbit",
        [
          [1, "AK F CC D", WALKED],
          [2, "YP D AK F", { ...WALKED, side: "sell" }],
        ],
        2
      )
      yield* day.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), {
        builtDays: UNTR_BUILT.builtDays,
        candles: [
          {
            day: DAY,
            open: 23_100,
            high: 23_100,
            low: 23_100,
            close: 23_100,
            volume: 8,
            value: 18_480_000,
            trades: 2,
          },
        ],
        totals: [
          untrTotal("AK", "F", [4, 9_240_000, 4, 9_240_000]),
          untrTotal("CC", "D", [0, 0, 4, 9_240_000]),
          untrTotal("YP", "D", [4, 9_240_000, 0, 0]),
        ],
      })
    })
  )

  it.effect(
    "of a day with no relay tape walked complete before 17:00 build in its 17:00 seal's wake, restarted between",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const sql = memorySql()
        yield* at("12:00:00")
        const day = yield* tradingDay(sql, [], db.layer)
        yield* at("16:40:00")
        yield* day.brokerCodes(
          "Stockbit",
          [
            [1, "AK F CC D", WALKED],
            [2, "YP D AK F", { ...WALKED, side: "sell" }],
          ],
          2
        )
        const restarted = yield* tradingDay(sql, [], db.layer)
        yield* at("17:00:00")
        yield* restarted.alarm
        assert.deepStrictEqual((yield* read(db, UNTR)).builtDays, [
          {
            ...UNTR_BUILT.builtDays[0],
            builtAt: "2026-11-09T10:00:00.000Z",
            missingTrades: 0,
          },
        ])
      })
  )

  it.effect(
    "of a day with no relay tape and a walk row Ajaib cut to 0 lots seal and build, the 0-lot row held",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        yield* at("17:30:00")
        const day = yield* tradingDay(memorySql(), [], db.layer)
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F CC D", WALKED],
            [2, "YP D AK F", { ...WALKED, lots: 0, board: "NG" }],
          ],
          2
        )
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), {
          builtDays: UNTR_BUILT.builtDays,
          candles: [
            {
              day: DAY,
              open: 23_100,
              high: 23_100,
              low: 23_100,
              close: 23_100,
              volume: 4,
              value: 9_240_000,
              trades: 1,
            },
          ],
          totals: [
            untrTotal("AK", "F", [4, 9_240_000, 0, 0]),
            untrTotal("CC", "D", [0, 0, 4, 9_240_000]),
          ],
        })
      })
  )

  it.effect("build after the object restarts before its alarm", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      const sql = memorySql()
      const sealed = yield* sealedDay(db, sql)
      yield* at("17:30:00")
      yield* sealed.brokerCodes("Ajaib", CODES, 7)
      yield* sealed.evicted

      const restarted = yield* tradingDay(sql, [], db.layer)
      yield* restarted.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
    })
  )

  it.effect("log the build's rows, D1 writes and time", () =>
    withLines("Broker totals built", (lines) =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* sealedDay(db)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", CODES, 7)
        yield* day.alarm
        assert.lengthOf(lines, 1)
        assert.strictEqual(lines[0]!.brokerTotalsRows, 6)
        assert.strictEqual(lines[0]!.brokerCandleRows, 2)
        assert.isAbove(Number(lines[0]!.brokerTotalsRowsWritten), 8)
        assert.isNumber(lines[0]!.brokerTotalsMillis)
      })
    )
  )
})

// UNTR as rebuilt once trade 2's buyer is corrected from AK to KZ.
const UNTR_CORRECTED = [
  untrTotal("AK", "F", [14, 32_240_000, 2, 4_680_000]),
  untrTotal("CC", "D", [0, 0, 10, 23_000_000]),
  untrTotal("KZ", "D", [3, 6_990_000, 0, 0]),
  untrTotal("YP", "D", [2, 4_680_000, 7, 16_230_000]),
]

// A sealed day built at 17:30.
const builtDay = Effect.fnUntraced(function* (
  db: ReturnType<typeof memoryBrokerTotalsDb>,
  sql = memorySql()
) {
  const day = yield* sealedDay(db, sql)
  yield* at("17:30:00")
  yield* day.brokerCodes("Ajaib", CODES, 7)
  yield* day.alarm
  return day
})

describe("a built day's correction", () => {
  it.effect(
    "rebuilds the day once, 5 quiet minutes after the last of a burst, its old figures read until then",
    () =>
      withLines("Broker totals built", (lines) =>
        Effect.gen(function* () {
          const db = memoryBrokerTotalsDb()
          const day = yield* builtDay(db)
          yield* at("18:00:00")
          yield* day.brokerCodes("Ajaib", [[2, "PD D YP D"]])
          assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
          yield* at("18:04:00")
          yield* day.alarm
          yield* day.brokerCodes("Ajaib", [[2, "KZ D YP D"]])
          yield* at("18:05:00")
          yield* day.alarm
          assert.deepStrictEqual(day.alarms.at(-1), wib("18:09:00"))
          yield* at("18:08:59")
          yield* day.alarm
          assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)

          yield* at("18:09:00")
          yield* day.alarm
          assert.deepStrictEqual(yield* read(db, UNTR), {
            ...UNTR_BUILT,
            builtDays: [
              {
                day: DAY,
                buildVersion: BROKER_TOTALS_VERSION,
                builtAt: "2026-11-09T11:09:00.000Z",
                missingTrades: 0,
              },
            ],
            totals: UNTR_CORRECTED,
          })
          yield* at("18:30:00")
          yield* day.alarm
          assert.lengthOf(lines, 2)
        })
      )
  )

  it.effect("rebuilds after the object restarts while the day is stale", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      const sql = memorySql()
      const day = yield* builtDay(db, sql)
      yield* at("18:00:00")
      yield* day.brokerCodes("Ajaib", [[2, "KZ D YP D"]])
      yield* day.evicted

      yield* at("18:01:00")
      const restarted = yield* tradingDay(sql, [], db.layer)
      yield* restarted.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
      yield* at("18:06:00")
      yield* restarted.alarm
      assert.deepStrictEqual((yield* read(db, UNTR)).totals, UNTR_CORRECTED)
    })
  )

  it.effect(
    "rebuilds once at the deadline the correction set, however often the object starts before it",
    () =>
      withLines("Broker totals built", (lines) =>
        Effect.gen(function* () {
          const db = memoryBrokerTotalsDb()
          const sql = memorySql()
          const day = yield* builtDay(db, sql)
          yield* at("18:00:00")
          yield* day.brokerCodes("Ajaib", [[2, "KZ D YP D"]])
          yield* day.evicted

          for (const time of ["18:02:00", "18:03:30", "18:04:59"]) {
            yield* at(time)
            const restarted = yield* tradingDay(sql, [], db.layer)
            assert.deepStrictEqual(restarted.alarms, [wib("18:05:00")])
            yield* restarted.alarm
            yield* restarted.evicted
          }
          assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)

          // The alarm rings on an evicted object: it starts, then fires.
          yield* at("18:05:00")
          const woken = yield* tradingDay(sql, [], db.layer)
          yield* woken.alarm
          assert.deepStrictEqual((yield* read(db, UNTR)).totals, UNTR_CORRECTED)
          yield* at("18:30:00")
          yield* woken.alarm
          assert.lengthOf(lines, 2)
        })
      )
  )

  it.effect(
    "that fills a trade's fields alone rebuilds the day, a gap while its codes-only trade waited",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* builtDay(db)
        yield* at("18:00:00")
        yield* day.brokerCodes("Stockbit", [[8, "AK F CC D"]], 8)
        yield* at("18:05:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)

        yield* at("18:10:00")
        yield* day.brokerCodes("Stockbit", [
          [
            8,
            "AK F CC D",
            {
              time: wib("09:00:50.000"),
              code: UNTR,
              price: 23_000,
              lots: 1,
              board: "RG",
              side: "buy",
            },
          ],
        ])
        yield* at("18:15:00")
        yield* day.alarm
        const rebuilt = yield* read(db, UNTR)
        assert.deepStrictEqual(rebuilt.candles, [
          {
            day: DAY,
            open: 23_000,
            high: 23_400,
            low: 23_000,
            close: 23_000,
            volume: 20,
            value: 46_210_000,
            trades: 5,
          },
        ])
        assert.deepStrictEqual(rebuilt.totals, [
          untrTotal("AK", "D", [3, 6_990_000, 0, 0]),
          untrTotal("AK", "F", [15, 34_540_000, 2, 4_680_000]),
          untrTotal("CC", "D", [0, 0, 11, 25_300_000]),
          untrTotal("YP", "D", [2, 4_680_000, 7, 16_230_000]),
        ])
      })
  )

  it.effect(
    "of a walk day sealed below a higher end holds the trades past it and rebuilds, its tape and candles unchanged",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const sql = memorySql()
        yield* at("17:30:00")
        const day = yield* tradingDay(sql, [], db.layer)
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F CC D", WALKED],
            [2, "YP D AK F", { ...WALKED, side: "sell" }],
          ],
          2
        )
        yield* day.alarm
        assert.strictEqual((yield* read(db, UNTR)).candles[0]?.trades, 2)
        const sealedCandles = yield* day.recordedCandles("UNTR")

        yield* at("18:00:00")
        yield* day.brokerCodes("Stockbit", [
          [3, "YP D AK F", { ...WALKED, price: 23_200 }],
        ])
        yield* day.brokerCodes("Stockbit", [], 3)
        yield* at("18:05:00")
        yield* day.alarm
        const restarted = yield* tradingDay(sql, [], db.layer)
        const status = yield* restarted.day.brokerCodes.status(
          new URLSearchParams()
        )
        const answer = yield* decodeBrokerCodesStatus(
          yield* Effect.promise(() => status.text())
        )
        assert.deepStrictEqual(answer.missing, [])
        assert.isTrue(answer.complete)
        assert.deepStrictEqual((yield* read(db, UNTR)).candles, [
          {
            day: DAY,
            open: 23_100,
            high: 23_200,
            low: 23_100,
            close: 23_200,
            volume: 12,
            value: 27_760_000,
            trades: 3,
          },
        ])
        assert.deepStrictEqual(
          yield* restarted.recordedCandles("UNTR"),
          sealedCandles
        )
      })
  )
})

describe("a due day", () => {
  it.effect(
    "whose build wake found it incomplete builds once a batch completes it again",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        yield* at("09:01:10")
        const day = yield* tradingDay(memorySql(), [], db.layer)
        yield* day.trades([TAPE[0]!])
        yield* at("17:00:00")
        yield* day.alarm
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", [[1, "AK F CC D"]], 1)
        // Before its build wake rings, an end raises N past a trade with
        // codes alone.
        yield* day.brokerCodes("Stockbit", [[2, "AK F CC D"]], 2)
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)

        yield* at("17:40:00")
        yield* day.brokerCodes("Stockbit", [[2, "AK F CC D", WALKED]])
        assert.deepStrictEqual(day.alarms.at(-1), wib("17:40:00"))
        yield* day.alarm
        assert.strictEqual((yield* read(db, UNTR)).candles[0]?.trades, 2)
      })
  )
})

describe("a reconcile poke", () => {
  it.effect("builds a sealed, complete day never marked for a build", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      const sql = memorySql()
      yield* at("09:01:10")
      const unbuilt = yield* tradingDay(sql)
      yield* unbuilt.trades(TAPE)
      yield* at("17:00:00")
      yield* unbuilt.alarm
      yield* unbuilt.brokerCodes("Ajaib", CODES, 7)
      yield* unbuilt.evicted

      yield* at("17:30:00")
      const day = yield* tradingDay(sql, [], db.layer)
      yield* day.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)
      assert.isTrue(yield* day.reconcile)
      yield* day.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), UNTR_BUILT)
    })
  )

  it.effect("rebuilds a day built by an older build version", () =>
    withLines("Broker totals built", (lines) =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const sql = memorySql()
        const built = yield* builtDay(db, sql)
        yield* built.evicted
        sql.exec(
          "INSERT OR REPLACE INTO facts VALUES (?, ?)",
          "broker-totals",
          String(BROKER_TOTALS_VERSION - 1)
        )

        yield* at("18:00:00")
        const day = yield* tradingDay(sql, [], db.layer)
        yield* day.alarm
        assert.lengthOf(lines, 1)
        assert.isTrue(yield* day.reconcile)
        yield* day.alarm
        assert.lengthOf(lines, 2)
        assert.deepStrictEqual((yield* read(db, UNTR)).builtDays, [
          {
            day: DAY,
            buildVersion: BROKER_TOTALS_VERSION,
            builtAt: "2026-11-09T11:00:00.000Z",
            missingTrades: 0,
          },
        ])
      })
    )
  )

  it.effect(
    "rebuilds a day its own fact calls built at this version, once the broker totals DB lost it",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        const built = yield* builtDay(memoryBrokerTotalsDb(), sql)
        yield* built.evicted

        yield* at("18:00:00")
        const reset = memoryBrokerTotalsDb()
        const day = yield* tradingDay(sql, [], reset.layer)
        assert.isTrue(yield* day.reconcile)
        yield* day.alarm
        assert.deepStrictEqual(yield* read(reset, UNTR), {
          ...UNTR_BUILT,
          builtDays: [
            {
              day: DAY,
              buildVersion: BROKER_TOTALS_VERSION,
              builtAt: "2026-11-09T11:00:00.000Z",
              missingTrades: 0,
            },
          ],
        })
      })
  )

  it.effect("does nothing on an unsealed or an incomplete day", () =>
    withLines("Broker totals built", (lines) =>
      Effect.gen(function* () {
        const unsealedDb = memoryBrokerTotalsDb()
        yield* at("09:01:10")
        const unsealed = yield* tradingDay(memorySql(), [], unsealedDb.layer)
        yield* unsealed.trades(TAPE)
        yield* at("16:00:00")
        yield* unsealed.brokerCodes("Ajaib", CODES, 7)
        assert.isFalse(yield* unsealed.reconcile)
        yield* unsealed.alarm
        assert.deepStrictEqual(yield* read(unsealedDb, UNTR), NOTHING)

        const incompleteDb = memoryBrokerTotalsDb()
        const incomplete = yield* sealedDay(incompleteDb)
        yield* at("17:30:00")
        yield* incomplete.brokerCodes("Ajaib", CODES.slice(0, 6), 7)
        assert.isFalse(yield* incomplete.reconcile)
        yield* incomplete.alarm
        assert.deepStrictEqual(yield* read(incompleteDb, UNTR), NOTHING)
        assert.lengthOf(lines, 0)
      })
    )
  )
})

// A day's database whose transactions fail while `failing` is set, and its
// broker totals DB.
const flakyDay = () => {
  const base = memorySql()
  const db = memoryBrokerTotalsDb()
  const flaky = { failing: false }
  const sql: Sql = {
    exec: base.exec,
    transaction: (write) => {
      // The storage API is synchronous and throws; runSync throws the failure.
      if (flaky.failing)
        return Effect.runSync(Effect.fail(new Error("Storage write failed")))
      base.transaction(write)
    },
  }
  const fixture = {
    db,
    sql,
    flaky,
    start: tradingDay(sql, [], db.layer),
    // A release before the broker trades index: no rows, no fact.
    dropIndex: Effect.sync(() => {
      base.exec("DELETE FROM broker_trades")
      base.exec("DELETE FROM facts WHERE key = 'broker-trades'")
    }),
    indexed: Effect.sync(
      () => base.exec("SELECT 1 FROM broker_trades LIMIT 1").length > 0
    ),
  }
  return fixture
}
type FlakyDay = ReturnType<typeof flakyDay>
type Day = Effect.Success<ReturnType<typeof tradingDay>>

const isSealed = (day: Day) =>
  Effect.map(
    day.recordedCandles("UNTR"),
    ({ cacheControl, answer }) =>
      cacheControl !== "no-store" && answer.candles.length > 0
  )

// Whether the day's broker totals were last built at `time`.
const builtAt = (fixture: FlakyDay, time: string) =>
  Effect.map(
    read(fixture.db, UNTR),
    ({ builtDays }) => builtDays[0]?.builtAt === DateTime.formatIso(wib(time))
  )

// Each wake, set for `deadline` by `arrange`, which leaves the object
// evicted, and whether its duty is done.
const WAKE_CASES: ReadonlyArray<{
  readonly wake: string
  readonly deadline: string
  readonly arrange: (fixture: FlakyDay) => Effect.Effect<void, unknown>
  readonly done: (
    fixture: FlakyDay,
    day: Day
  ) => Effect.Effect<boolean, unknown>
}> = [
  {
    wake: "seal",
    deadline: "17:00:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* fixture.start
        yield* day.trades(TAPE)
        // Past the minute's flush, so the tape is stored.
        yield* TestClock.adjust("70 seconds")
        yield* day.evicted
      }),
    done: (_, day) => isSealed(day),
  },
  {
    wake: "seal retried",
    deadline: "17:01:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* fixture.start
        yield* day.trades(TAPE)
        yield* at("17:00:00")
        fixture.flaky.failing = true
        yield* day.alarm
        fixture.flaky.failing = false
        yield* day.evicted
      }),
    done: (_, day) => isSealed(day),
  },
  {
    wake: "index, set for the seal",
    deadline: "17:00:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* fixture.start
        yield* day.trades(TAPE)
        yield* TestClock.adjust("70 seconds")
        yield* day.brokerCodes("Ajaib", CODES, 7)
        yield* day.evicted
        yield* fixture.dropIndex
        yield* at("12:00:00")
        yield* (yield* fixture.start).evicted
      }),
    done: (fixture) => fixture.indexed,
  },
  {
    wake: "index retried",
    deadline: "17:46:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        yield* (yield* builtDay(fixture.db, fixture.sql)).evicted
        yield* fixture.dropIndex
        yield* at("17:45:00")
        const day = yield* fixture.start
        fixture.flaky.failing = true
        yield* day.alarm
        fixture.flaky.failing = false
        yield* day.evicted
      }),
    done: (fixture) => fixture.indexed,
  },
  {
    wake: "build retried",
    deadline: "17:31:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        const day = yield* sealedDay(fixture.db, fixture.sql)
        yield* at("17:30:00")
        fixture.db.failBatch = () => true
        yield* day.brokerCodes("Ajaib", CODES, 7)
        yield* day.alarm
        fixture.db.failBatch = undefined
        yield* day.evicted
      }),
    done: (fixture) => builtAt(fixture, "17:31:00"),
  },
  {
    wake: "stale rebuild",
    deadline: "18:05:00",
    arrange: (fixture) =>
      Effect.gen(function* () {
        const day = yield* builtDay(fixture.db, fixture.sql)
        yield* at("18:00:00")
        yield* day.brokerCodes("Ajaib", [[2, "KZ D YP D"]])
        yield* day.evicted
      }),
    done: (fixture) => builtAt(fixture, "18:05:00"),
  },
]

describe("every kind of wake", () => {
  it.effect.each(WAKE_CASES)(
    "survives a restart at its original deadline: $wake",
    ({ wake, deadline, arrange, done }) =>
      Effect.gen(function* () {
        const fixture = flakyDay()
        yield* arrange(fixture)

        yield* TestClock.setTime(DateTime.toEpochMillis(wib(deadline)) - 30_000)
        const early = yield* fixture.start
        assert.deepStrictEqual(early.alarms, [wib(deadline)], wake)
        yield* early.alarm
        assert.isFalse(yield* done(fixture, early), wake)
        yield* early.evicted

        yield* at(deadline)
        const woken = yield* fixture.start
        yield* woken.alarm
        assert.isTrue(yield* done(fixture, woken), wake)
      })
  )
})

describe("a failed broker totals build", () => {
  it.effect("retries a minute later and then succeeds", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      const day = yield* sealedDay(db)
      yield* at("17:30:00")
      db.failBatch = () => true
      yield* day.brokerCodes("Ajaib", CODES, 7)
      yield* day.alarm
      db.failBatch = undefined
      assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)
      assert.deepStrictEqual(day.alarms.at(-1), wib("17:31:00"))

      yield* at("17:31:00")
      yield* day.alarm
      assert.deepStrictEqual(yield* read(db, UNTR), {
        ...UNTR_BUILT,
        builtDays: [
          {
            day: DAY,
            buildVersion: BROKER_TOTALS_VERSION,
            builtAt: "2026-11-09T10:31:00.000Z",
            missingTrades: 0,
          },
        ],
      })
    })
  )
})

// A day of 1,000 trades: its gate lets 1 missing trade build, 2 not.
const N = 1_000

// Walk rows of trades `from`..N with fields, but none for `unfilled` and
// codes alone for `codesOnly`.
const walkRows = (
  from: number,
  unfilled: ReadonlyArray<number>,
  codesOnly: ReadonlyArray<number> = []
) =>
  Array.from({ length: N - from + 1 }, (_, offset) => from + offset)
    .filter((number) => !unfilled.includes(number))
    .map((number) =>
      codesOnly.includes(number)
        ? ([number, "AK F CC D"] as const)
        : ([number, "AK F CC D", WALKED] as const)
    )

// When the day's broker totals were built and the trades they missed, as
// the DB reads them.
const builds = (db: ReturnType<typeof memoryBrokerTotalsDb>) =>
  Effect.map(read(db, UNTR), ({ builtDays }) =>
    builtDays.map((built) => [built.builtAt, built.missingTrades])
  )

describe("a sealed day missing at most 0.1% of its trades", () => {
  it.effect(
    "builds once a batch brings its missing trades from 0.2% to 0.1%, and rebuilds once a later one fills the last",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* sealedDay(db)
        yield* at("17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          [...CODES, ...walkRows(8, [], [500, 600])],
          N
        )
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [])

        yield* at("17:40:00")
        yield* day.brokerCodes("Ajaib", [[600, "AK F CC D", WALKED]])
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T10:40:00.000Z", 1],
        ])

        yield* at("18:00:00")
        yield* day.brokerCodes("Ajaib", [[500, "AK F CC D", WALKED]])
        yield* at("18:05:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T11:05:00.000Z", 0],
        ])
      })
  )

  it.effect(
    "rebuilds with its new missing count once a later end raises N past a trade no site sends",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* sealedDay(db)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", [...CODES, ...walkRows(8, [N])], N - 1)
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T10:30:00.000Z", 0],
        ])

        yield* at("18:00:00")
        yield* day.brokerCodes("Stockbit", [], N)
        yield* at("18:05:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T11:05:00.000Z", 1],
        ])
      })
  )

  it.effect(
    "reads as a gap once a later end pushes it past 0.1% missing, and rebuilds once a batch brings it back",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const day = yield* sealedDay(db)
        yield* at("17:30:00")
        yield* day.brokerCodes("Ajaib", [...CODES, ...walkRows(8, [N])], N - 1)
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T10:30:00.000Z", 0],
        ])

        yield* at("18:00:00")
        yield* day.brokerCodes("Stockbit", [], N + 1)
        yield* at("18:05:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* read(db, UNTR), NOTHING)
        const rows = (table: string) =>
          db.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
        assert.deepStrictEqual(
          [rows("built_days"), rows("totals"), rows("candles")],
          [{ n: 0 }, { n: 0 }, { n: 0 }]
        )

        yield* at("18:30:00")
        yield* day.brokerCodes("Ajaib", [[N, "AK F CC D", WALKED]])
        yield* at("18:35:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* builds(db), [
          ["2026-11-09T11:35:00.000Z", 1],
        ])
      })
  )

  it.effect("of walks, with a trade no site ever sends, seals and builds", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      yield* at("17:30:00")
      const day = yield* tradingDay(memorySql(), [], db.layer)
      yield* day.brokerCodes("Ajaib", walkRows(1, [700]), N)
      yield* day.alarm
      assert.isTrue(yield* isSealed(day))
      assert.deepStrictEqual(yield* builds(db), [
        ["2026-11-09T10:30:00.000Z", 1],
      ])
    })
  )

  it.effect("builds on a reconcile poke, never marked for a build", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      const sql = memorySql()
      yield* at("09:01:10")
      const unbuilt = yield* tradingDay(sql)
      yield* unbuilt.trades(TAPE)
      yield* at("17:00:00")
      yield* unbuilt.alarm
      yield* unbuilt.brokerCodes("Ajaib", [...CODES, ...walkRows(8, [500])], N)
      yield* unbuilt.evicted

      yield* at("17:30:00")
      const day = yield* tradingDay(sql, [], db.layer)
      yield* day.alarm
      assert.deepStrictEqual(yield* builds(db), [])
      assert.isTrue(yield* day.reconcile)
      yield* day.alarm
      assert.deepStrictEqual(yield* builds(db), [
        ["2026-11-09T10:30:00.000Z", 1],
      ])
    })
  )
})

describe("a held trade", () => {
  it("carries its board as the tape's Board, not a bare string", () => {
    type Page = Effect.Success<ReturnType<BrokerCodesStore["heldTradesPage"]>>
    expectTypeOf<NonNullable<Page>["trades"][number]["board"]>().toEqualTypeOf<
      RunningTrade["board"]
    >()
  })
})
