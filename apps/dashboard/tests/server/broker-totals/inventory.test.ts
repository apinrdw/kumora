// Spec apinrdw/kumora#437, "Dashboard: broker inventory read and math": the
// Broker inventory tab's range read, over the memory D1 fake.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { writeBuiltDay, type DayBuild } from "@/server/broker-totals/db"
import { brokerInventory } from "@/server/broker-totals/inventory"

import { memoryBrokerTotalsDb } from "./memory-broker-totals-db.ts"

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")
const BUILT_AT = DateTime.makeUnsafe("2026-11-11T10:00:00Z")

const total = (
  code: StockCode,
  broker: string,
  investorType: "D" | "F",
  buyLots: number,
  sellLots: number
) => ({
  code,
  broker: BrokerCode.make(broker),
  investorType,
  buyLots,
  buyValue: buyLots * 800_000,
  sellLots,
  sellValue: sellLots * 800_000,
})

const candle = (code: StockCode, close: number) => ({
  code,
  open: 8_000,
  high: 8_100,
  low: 7_900,
  close,
  volume: 10,
  value: 8_000_000,
  trades: 12,
})

const build = (close: number): DayBuild => ({
  totals: [
    total(BBCA, "YP", "D", 2, 0),
    total(BBCA, "AK", "F", 0, 2),
    total(TLKM, "YP", "D", 3, 3),
  ],
  candles: [candle(BBCA, close), candle(TLKM, 3_500)],
})

// TLKM alone traded.
const quiet: DayBuild = {
  totals: [total(TLKM, "YP", "D", 3, 3)],
  candles: [candle(TLKM, 3_500)],
}

const built = (days: Readonly<Record<string, DayBuild>>) =>
  Effect.forEach(Object.entries(days), ([day, dayBuild]) =>
    writeBuiltDay(WibDate.make(day), dayBuild, 1, BUILT_AT)
  )

const day = (date: string) => WibDate.make(date)

describe("the broker inventory read", () => {
  it.effect(
    "ends a preset at the newest built day, with today pending and a gap kept",
    () => {
      const db = memoryBrokerTotalsDb()
      return Effect.gen(function* () {
        // Mon 9 to Thu 12 Nov; Tuesday was never built, and on Wednesday
        // BBCA didn't trade. Friday the 13th is today, not built yet.
        yield* built({
          "2026-11-09": build(8_050),
          "2026-11-11": quiet,
          "2026-11-12": build(8_100),
        })
        const read = yield* brokerInventory(
          BBCA,
          { range: "2W" },
          day("2026-11-13")
        )
        assert.deepStrictEqual(read, {
          from: day("2026-10-30"),
          to: day("2026-11-12"),
          earliest: day("2026-11-09"),
          pending: day("2026-11-13"),
          days: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"].map(
            day
          ),
          built: [true, false, true, true],
          candles: {
            day: [0, 3],
            open: [8_000, 8_000],
            high: [8_100, 8_100],
            low: [7_900, 7_900],
            close: [8_050, 8_100],
            volume: [10, 10],
            value: [8_000_000, 8_000_000],
            trades: [12, 12],
          },
          brokers: [BrokerCode.make("AK"), BrokerCode.make("YP")],
          totals: {
            day: [0, 0, 3, 3],
            broker: [0, 1, 0, 1],
            investorType: ["F", "D", "F", "D"],
            buyLots: [0, 2, 0, 2],
            buyValue: [0, 1_600_000, 0, 1_600_000],
            sellLots: [2, 0, 2, 0],
            sellValue: [1_600_000, 0, 1_600_000, 0],
          },
        })
      }).pipe(Effect.provide(db.layer))
    }
  )

  it.effect(
    "ends at today once it is built, and says nothing is pending",
    () => {
      const db = memoryBrokerTotalsDb()
      return Effect.gen(function* () {
        yield* built({ "2026-11-12": build(8_100), "2026-11-13": build(8_150) })
        const read = yield* brokerInventory(
          BBCA,
          { range: "3M" },
          day("2026-11-13")
        )
        assert.strictEqual(read.to, "2026-11-13")
        assert.strictEqual(read.from, "2026-08-14")
        assert.strictEqual(read.pending, undefined)
        assert.deepStrictEqual(read.days, [
          day("2026-11-12"),
          day("2026-11-13"),
        ])
      }).pipe(Effect.provide(db.layer))
    }
  )

  it.effect("never calls a weekend today pending", () => {
    const db = memoryBrokerTotalsDb()
    return Effect.gen(function* () {
      yield* built({ "2026-11-13": build(8_150) })
      const read = yield* brokerInventory(
        BBCA,
        { range: "3M" },
        day("2026-11-14")
      )
      assert.strictEqual(read.pending, undefined)
      assert.strictEqual(read.to, "2026-11-13")
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("keeps a holiday off the axis, so it never reads as a gap", () => {
    const db = memoryBrokerTotalsDb()
    return Effect.gen(function* () {
      // Monday 17 Aug 2026 is Independence Day.
      yield* built({ "2026-08-14": build(8_000), "2026-08-18": build(8_050) })
      const read = yield* brokerInventory(
        BBCA,
        { from: day("2026-08-14"), to: day("2026-08-18") },
        day("2026-11-13")
      )
      assert.deepStrictEqual(read.days, [day("2026-08-14"), day("2026-08-18")])
      assert.deepStrictEqual(read.built, [true, true])
    }).pipe(Effect.provide(db.layer))
  })

  it.effect(
    "ends a Custom range at the newest built day and starts its axis at the first",
    () => {
      const db = memoryBrokerTotalsDb()
      return Effect.gen(function* () {
        yield* built({ "2026-11-11": build(8_000), "2026-11-12": build(8_050) })
        const read = yield* brokerInventory(
          BBCA,
          { from: day("2026-10-01"), to: day("2026-12-31") },
          day("2026-11-13")
        )
        assert.strictEqual(read.from, "2026-10-01")
        assert.strictEqual(read.to, "2026-11-12")
        assert.deepStrictEqual(read.days, [
          day("2026-11-11"),
          day("2026-11-12"),
        ])
      }).pipe(Effect.provide(db.layer))
    }
  )

  it.effect("moves a Custom From up to 2 years before its To", () => {
    const db = memoryBrokerTotalsDb()
    return Effect.gen(function* () {
      yield* built({ "2026-11-12": build(8_050) })
      const read = yield* brokerInventory(
        BBCA,
        { from: day("2019-01-01"), to: day("2026-11-12") },
        day("2026-11-13")
      )
      assert.strictEqual(read.from, "2024-11-13")
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("reads an empty range before any day is built", () => {
    const db = memoryBrokerTotalsDb()
    return Effect.gen(function* () {
      const read = yield* brokerInventory(
        BBCA,
        { range: "3M" },
        day("2026-11-13")
      )
      assert.strictEqual(read.earliest, undefined)
      assert.strictEqual(read.pending, day("2026-11-13"))
      assert.deepStrictEqual(read.days, [])
      assert.deepStrictEqual(read.brokers, [])
    }).pipe(Effect.provide(db.layer))
  })
})
