// Spec apinrdw/kumora#437, "Dashboard: TradingDay" (The build, When it
// runs): a complete sealed day's broker totals and candles, built on the
// trading day's alarm into the memory broker totals DB and read back by
// range.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  StockCode,
  WibDate,
  type TradeFields,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { readBrokerTotals } from "@/server/broker-totals/db"
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
  code: UNTR,
  price: 23_100,
  lots: 4,
  board: "RG",
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
