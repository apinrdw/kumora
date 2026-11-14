// Seam (1) of spec apinrdw/kumora#263 for the Staging cost check (ticket
// apinrdw/kumora#270): what a day's flushes write and what its order flow
// tables hold, read from the log lines Workers Logs keeps.
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Logger, References } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, tradingDay } from "./day-harness"

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

type Line = Readonly<Record<string, unknown>>

// Runs `test` with the annotations of every line logged with `message`.
const withLines = <A, E, R>(
  message: string,
  test: (lines: ReadonlyArray<Line>) => Effect.Effect<A, E, R>
) => {
  const lines: Array<Line> = []
  const capture = Logger.make(({ message: logged, fiber }) => {
    const [text] = Array.isArray(logged) ? logged : [logged]
    if (text === message)
      lines.push(fiber.getRef(References.CurrentLogAnnotations) as Line)
  })
  return test(lines).pipe(Effect.provide(Logger.layer([capture])))
}

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
        })
      )
  )
})
