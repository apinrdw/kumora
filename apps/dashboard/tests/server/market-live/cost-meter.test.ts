// Seam (1) of spec apinrdw/kumora#263 for the Staging cost check (ticket
// apinrdw/kumora#270): what a day's flushes write and what its order flow
// tables hold, read from the log lines Workers Logs keeps.
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, tradingDay, withLines, type Line } from "./day-harness"
import { counted, memorySql } from "./sql"

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

const sum = (lines: ReadonlyArray<Line>, field: string) =>
  lines.reduce((total, line) => total + Number(line[field] ?? 0), 0)

const untr = (number: number, time: string, lots: number) =>
  stockbitTrade({ number, time, price: 23300, lots, side: "buy" })
const bbca = (number: number, time: string) =>
  stockbitTrade({
    number,
    time,
    code: "BBCA",
    price: 8000,
    lots: 1,
    side: "sell",
  })

describe("the cost meter", () => {
  it.effect(
    "each flush logs the rows it wrote by table, and the late trades that read a stored minute back",
    () =>
      withLines("Rows written", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay()
          yield* day.trades([
            untr(40001, "09:00:10.100", 2),
            bbca(40002, "09:00:10.200"),
            untr(40003, "09:01:00.000", 3),
          ])
          // Past both minutes' flushes.
          yield* TestClock.adjust("2 minutes")
          assert.strictEqual(sum(lines, "trades"), 3)
          assert.strictEqual(sum(lines, "candles"), 3)
          assert.strictEqual(sum(lines, "footprints"), 3)
          assert.strictEqual(sum(lines, "minuteRereads"), 0)

          // A backfilled trade numbered below 09:00's stored sweeps.
          yield* day.trades([untr(39999, "09:00:05.000", 1)])
          yield* TestClock.adjust("1 minute")
          assert.strictEqual(sum(lines, "trades"), 4)
          assert.strictEqual(sum(lines, "footprints"), 4)
          assert.strictEqual(sum(lines, "minuteRereads"), 1)
        })
      )
  )

  it.effect(
    "the seal logs how many order flow rows the day holds and their bytes",
    () =>
      withLines("Order flow storage", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay()
          yield* day.trades([
            untr(40001, "09:00:10.100", 2),
            bbca(40002, "09:00:10.200"),
            untr(40003, "09:01:00.000", 3),
          ])
          assert.strictEqual(lines.length, 0)
          yield* at("17:00:00")
          yield* day.alarm
          assert.strictEqual(lines.length, 1)
          assert.strictEqual(lines[0]!.footprintRows, 3)
          assert.strictEqual(lines[0]!.heatmapRows, 0)
          assert.isAbove(Number(lines[0]!.footprintBytes), 0)
          assert.strictEqual(lines[0]!.sweepBrokerRows, 0)
        })
      )
  )
})

// UNTR's two sweeps over two minutes and BBCA's one, each trade's codes,
// buyer then seller: the day's whole tape, so its codes can be complete.
const SWEPT = [
  untr(1, "09:00:10.100", 2),
  bbca(2, "09:00:10.200"),
  untr(3, "09:01:00.000", 3),
]
const CODES = [
  [1, "AK F CC D"],
  [2, "PD F KZ D"],
  [3, "YP D ZP F"],
] as const

describe("the sweep brokers meter", () => {
  it.effect(
    "a recompute after the seal logs the minutes it read, the rows it read and the rows it wrote",
    () =>
      withLines("Sweep brokers recomputed", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay(counted(memorySql()))
          yield* day.trades(SWEPT)
          yield* at("17:00:00")
          yield* day.alarm
          assert.lengthOf(lines, 0)

          yield* at("17:30:00")
          yield* day.brokerCodes("Ajaib", CODES.slice(0, 2))
          yield* day.brokerCodes("Ajaib", CODES.slice(2))
          assert.lengthOf(lines, 2)
          assert.strictEqual(lines[0]!.sweepBrokerMinutes, 1)
          assert.strictEqual(lines[0]!.sweepBrokers, 2)
          assert.strictEqual(lines[1]!.sweepBrokerMinutes, 1)
          assert.strictEqual(lines[1]!.sweepBrokers, 1)
          // Each minute's whole market of trades, at least.
          assert.isAtLeast(Number(lines[0]!.billedSweepBrokerReadRows), 2)
          assert.isAtLeast(Number(lines[1]!.billedRowsWritten), 1)
        })
      )
  )

  it.effect(
    "a recompute before the seal adds its rows to the next flush's line",
    () =>
      withLines("Rows written", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay()
          yield* day.trades(SWEPT)
          yield* TestClock.adjust("2 minutes")
          assert.strictEqual(sum(lines, "sweepBrokers"), 0)
          yield* at("16:30:00")
          yield* day.brokerCodes("Ajaib", CODES)
          yield* at("17:00:00")
          yield* day.alarm
          assert.strictEqual(sum(lines, "sweepBrokers"), 3)
          assert.strictEqual(sum(lines, "sweepBrokerMinutes"), 2)
        })
      )
  )

  it.effect(
    "logs the day's storage again, with the table's rows and bytes, once its codes are complete",
    () =>
      withLines("Order flow storage", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay()
          yield* day.trades(SWEPT)
          yield* at("17:00:00")
          yield* day.alarm
          assert.lengthOf(lines, 1)

          yield* at("17:30:00")
          yield* day.brokerCodes("Ajaib", CODES.slice(0, 2), 3)
          assert.lengthOf(lines, 1)
          yield* day.brokerCodes("Ajaib", CODES.slice(2))
          assert.lengthOf(lines, 2)
          assert.strictEqual(lines[1]!.sweepBrokerRows, 3)
          assert.isAbove(Number(lines[1]!.sweepBrokerBytes), 0)
          assert.strictEqual(lines[1]!.footprintRows, 3)
          // A batch after the day was complete logs no more.
          yield* day.brokerCodes("Stockbit", CODES.slice(2))
          assert.lengthOf(lines, 2)
        })
      )
  )

  it.effect(
    "logs the day's storage again when the walk's empty final batch completes its codes",
    () =>
      withLines("Order flow storage", (lines) =>
        Effect.gen(function* () {
          yield* at("09:00:12")
          const day = yield* tradingDay()
          yield* day.trades(SWEPT)
          yield* at("17:00:00")
          yield* day.alarm
          yield* at("17:30:00")
          yield* day.brokerCodes("Ajaib", CODES)
          assert.lengthOf(lines, 1)
          yield* day.brokerCodes("Ajaib", [], 3)
          assert.lengthOf(lines, 2)
          assert.strictEqual(lines[1]!.sweepBrokerRows, 3)
        })
      )
  )
})
