// Ticket apinrdw/kumora#558: once a WIB day, a trading day object that ran
// logs what its SQL adapter counted, for the owner to read in Workers Logs.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitTrade, tradingDay, withLines } from "./day-harness"
import { counted, memorySql } from "./sql"

const at = (date: string, time: string) =>
  TestClock.setTime(Date.parse(`${date}T${time}+07:00`))

describe("the usage line", () => {
  it.effect(
    "a day object logs one line a WIB day, at its seal and then at its first wake of each later day, across restarts, without an alarm",
    () =>
      withLines("Durable Object usage", (lines) =>
        Effect.gen(function* () {
          // One database; each object counts afresh, as a woken one does.
          const base = memorySql()
          yield* at("2026-11-09", "09:00:12")
          const live = yield* tradingDay(counted(base))
          yield* live.trades([
            stockbitTrade({
              number: 1,
              time: "09:00:10.100",
              price: 23300,
              lots: 2,
              side: "buy",
            }),
          ])
          yield* TestClock.adjust("2 minutes")
          assert.strictEqual(lines.length, 0, "no line before the seal")

          yield* at("2026-11-09", "17:00:00")
          yield* live.alarm
          assert.strictEqual(lines.length, 1, "the seal logs the day's line")
          assert.isAbove(Number(lines[0]!.rowsRead), 0)
          assert.isAbove(Number(lines[0]!.rowsWritten), 0)
          assert.strictEqual(typeof lines[0]!.bytes, "number")

          yield* live.recordedCandles("UNTR")
          yield* live.evicted
          yield* at("2026-11-09", "20:00:00")
          const evening = yield* tradingDay(counted(base))
          yield* evening.recordedCandles("UNTR")
          assert.strictEqual(lines.length, 1, "one line the same day")
          yield* evening.evicted

          yield* at("2026-11-10", "10:00:00")
          const next = yield* tradingDay(counted(base))
          const alarms = next.alarms.length
          yield* next.recordedCandles("UNTR")
          assert.strictEqual(lines.length, 2, "the next day's first wake logs")
          yield* next.recordedCandles("UNTR")
          yield* next.evicted
          const again = yield* tradingDay(counted(base))
          yield* again.recordedCandles("UNTR")
          assert.strictEqual(lines.length, 2, "one line that day too")
          assert.strictEqual(next.alarms.length, alarms, "no alarm for it")
        })
      )
  )
})
