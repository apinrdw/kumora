// When a sealed day moves to R2 (spec apinrdw/kumora#556, "Hot and cold
// days" and "The move"): once its walk is done, or once it leaves the
// 10-trading-day window, from midnight after it and outside Streaming hours;
// and what the emptied day answers a broker codes batch and status GET.
import { assert, describe, it } from "@effect/vitest"
import { WibDate, decodeDayStrip } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeDayIndex } from "@/server/market-live/day-index"

import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db"
import { stockbitTrade, tradingDay } from "./day-harness"
import { memoryDayBucket } from "./memory-day-bucket"
import { memorySql } from "./sql"

const DAY = WibDate.make("2026-11-09")

const instant = (wall: string) => DateTime.makeUnsafe(`${wall}+07:00`)
const at = (wall: string) =>
  TestClock.setTime(DateTime.toEpochMillis(instant(wall)))

// A relay day of trades 1 and 2, sealed at 17:00, its row in a day index,
// moving to a bucket in memory; its builds write to a broker totals DB.
const sealedDay = Effect.fnUntraced(function* () {
  yield* at("2026-11-09T09:01:10")
  const index = yield* makeDayIndex(memorySql())
  const days = memoryDayBucket()
  const day = yield* tradingDay(memorySql(), [], memoryBrokerTotalsDb().layer, {
    bucket: days.bucket,
    markCold: index.markCold(DAY),
  })
  yield* day.trades([
    stockbitTrade({ number: 1, time: "09:00:10.100", price: 23300, lots: 3 }),
    stockbitTrade({ number: 2, time: "09:00:20.000", price: 23325, lots: 5 }),
  ])
  yield* at("2026-11-09T17:00:00")
  yield* day.alarm
  yield* index.record({ day: DAY, trades: 2, gap: false })
  const cold = Effect.map(
    Effect.flatMap(
      Effect.flatMap(index.strip, (response) =>
        Effect.promise(() => response.text())
      ),
      decodeDayStrip
    ),
    (strip) => strip.days[0]?.cold === true
  )
  return { day, days, cold }
})

// The alarm run while its earliest wake is due.
const dueAlarms = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof sealedDay>>["day"]
) {
  for (let run = 0; run < 20 && !(yield* day.emptied); run++) {
    const due = day.alarms.at(-1)
    if (due === undefined || DateTime.isGreaterThan(due, yield* DateTime.now))
      return
    yield* day.alarm
  }
})

const statusOf = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof sealedDay>>["day"],
  search = ""
) {
  const response = yield* day.day.brokerCodes.status(
    new URLSearchParams(search)
  )
  assert.strictEqual(response.status, 200)
  return JSON.parse(yield* Effect.promise(() => response.text()))
})

describe("a sealed day's move to R2", () => {
  it.effect(
    "starts once its codes are complete and its broker totals built, at midnight after it",
    () =>
      Effect.gen(function* () {
        const { day, cold } = yield* sealedDay()
        yield* at("2026-11-09T17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F BK D"],
            [2, "YP D KZ F"],
          ],
          2
        )
        // The completing batch arms the build; the build arms the move.
        yield* day.alarm
        assert.deepStrictEqual(
          day.alarms.at(-1),
          instant("2026-11-10T00:00:00")
        )
        assert.isFalse(yield* day.emptied)

        yield* at("2026-11-10T00:00:00")
        yield* dueAlarms(day)
        assert.isTrue(yield* day.emptied)
        assert.isTrue(yield* cold)
      })
  )

  it.effect(
    "of an incomplete day waits until ten trading days came after it",
    () =>
      Effect.gen(function* () {
        const { day } = yield* sealedDay()
        yield* at("2026-11-09T17:30:00")
        yield* day.brokerCodes("Ajaib", [[1, "AK F BK D"]], 2)
        yield* day.alarm
        // 2026-11-23 is the tenth trading day after; it counts from its seal.
        yield* at("2026-11-23T16:59:59")
        assert.isFalse(yield* day.move)
        yield* at("2026-11-23T17:00:00")
        assert.isTrue(yield* day.move)
        yield* dueAlarms(day)
        assert.isTrue(yield* day.emptied)
      })
  )

  it.effect("waits for Streaming hours to end, a step at a time", () =>
    Effect.gen(function* () {
      const { day } = yield* sealedDay()
      yield* at("2026-11-24T09:00:00")
      assert.isTrue(yield* day.move)
      yield* day.alarm
      assert.deepStrictEqual(day.alarms.at(-1), instant("2026-11-24T16:35:00"))
      assert.isFalse(yield* day.emptied)
      yield* at("2026-11-24T16:35:00")
      yield* dueAlarms(day)
      assert.isTrue(yield* day.emptied)
    })
  )

  it.effect(
    "of a day out of the window, once emptied, takes a batch writing nothing and answers its final status, its missing ranges past `after`",
    () =>
      Effect.gen(function* () {
        const { day, days } = yield* sealedDay()
        yield* at("2026-11-09T17:30:00")
        yield* day.brokerCodes("Ajaib", [[2, "YP D KZ F"]], 3)
        const hot = yield* statusOf(day)
        assert.isFalse(hot.complete)
        assert.deepStrictEqual(hot.missing, [
          ["1", "1"],
          ["3", "3"],
        ])
        assert.isTrue(yield* day.movedToR2)

        yield* day.brokerCodes("Ajaib", [[1, "AK F BK D"]])
        assert.deepStrictEqual(yield* statusOf(day), hot)
        assert.deepStrictEqual((yield* statusOf(day, "after=1")).missing, [
          ["3", "3"],
        ])
        assert.deepStrictEqual((yield* statusOf(day, "after=2")).missing, [
          ["3", "3"],
        ])
        assert.deepStrictEqual((yield* statusOf(day, "after=3")).missing, [])
        assert.strictEqual(
          (yield* day.day.brokerCodes.status(new URLSearchParams("after=x")))
            .status,
          400
        )
        assert.isTrue(days.objects.has("days/2026-11-09/status.json"))
      })
  )

  it.effect(
    "of a complete day, once emptied, answers its status complete",
    () =>
      Effect.gen(function* () {
        const { day } = yield* sealedDay()
        yield* at("2026-11-09T17:30:00")
        yield* day.brokerCodes(
          "Ajaib",
          [
            [1, "AK F BK D"],
            [2, "YP D KZ F"],
          ],
          2
        )
        // Its build.
        yield* day.alarm
        assert.isTrue(yield* day.movedToR2)
        const status = yield* statusOf(day)
        assert.isTrue(status.complete)
        assert.deepStrictEqual(status.missing, [])
      })
  )

  it.effect(
    "is asked of the day leaving the window when today's day seals",
    () =>
      Effect.gen(function* () {
        const { day } = yield* sealedDay()
        assert.deepStrictEqual(day.asked, [WibDate.make("2026-10-26")])
      })
  )
})
