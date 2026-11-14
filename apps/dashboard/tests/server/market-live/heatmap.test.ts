// Seam (1) of spec apinrdw/kumora#263 for the book heatmap (ticket
// apinrdw/kumora#267): Stockbit order book frames go in through the ingest
// socket, time moves only by TestClock, and the test reads the heatmap GET's
// answers.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  decodeRecordedHeatmap,
  recordedDayPath,
  recordedDayRequest,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { SEALED_CACHE } from "@/server/market-live/routes"

import { stockbitBook, tradingDay } from "./day-harness"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
// A frame sent at `time` is served with the delta 250 ms later.
const SERVED_AFTER = "250 millis"

const UNTR = StockCode.make("UNTR")

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// The heatmap GET's answer for UNTR: its Cache-Control, the slice time it
// answers up to, and each slice as [WIB time, levels].
const heatmap = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({ _tag: "Heatmap", code: UNTR })
  const answer = yield* decodeRecordedHeatmap(
    yield* Effect.promise(() => response.text())
  )
  const time = (instant: DateTime.Utc) =>
    DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(11, 19)
  return {
    cacheControl: response.headers.get("Cache-Control"),
    code: answer.code,
    through: time(answer.through),
    slices: answer.slices.map((slice): ReadonlyArray<unknown> => [
      time(slice.at),
      slice.levels.map((level) => [...level]),
    ]),
  }
})

// UNTR's book on 2026-11-09: 50 lots bid at 8,000 and 40 offered at 8,025,
// served at 14:20:04; the bid grows to 90 at 14:20:15.
const bookMinute1420 = Effect.gen(function* () {
  yield* at("14:20:03.750")
  const day = yield* tradingDay()
  yield* day.viewer("UNTR")
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[8_000, 3, 50]], time: "14:20:03" }),
    stockbitBook({ side: "OFFER", levels: [[8_025, 2, 40]], time: "14:20:03" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
  yield* at("14:20:14.750")
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[8_000, 5, 90]], time: "14:20:14" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
  return day
})

// Then at 14:21:22.5 the offer drops to 20.
const bookDay = Effect.gen(function* () {
  const day = yield* bookMinute1420
  yield* at("14:21:22.250")
  yield* day.frames([
    stockbitBook({ side: "OFFER", levels: [[8_025, 1, 20]], time: "14:21:22" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
  return day
})

// Minute 14:20 as its closed chunk weighs it.
const minute1420 = [
  // No book until 14:20:04: 6 s of 10.
  [
    "14:20:00",
    [
      [8_000, 30, 0],
      [8_025, 0, 24],
    ],
  ],
  // 50 lots for 5 s, then 90 for 5 s.
  [
    "14:20:10",
    [
      [8_000, 70, 0],
      [8_025, 0, 40],
    ],
  ],
  ...["14:20:20", "14:20:30", "14:20:40", "14:20:50"].map((time) => [
    time,
    [
      [8_000, 90, 0],
      [8_025, 0, 40],
    ],
  ]),
]

describe("the book heatmap", () => {
  it.effect(
    "a live GET answers the closed chunks' slices and the open one's to the last whole slice, named as its join",
    () =>
      Effect.gen(function* () {
        const day = yield* bookDay
        // Past 14:21:05's flush, mid-slice.
        yield* at("14:21:35.000")
        const answer = yield* heatmap(day)
        assert.strictEqual(answer.cacheControl, "no-store")
        assert.strictEqual(answer.code, "UNTR")
        // The page builds 14:21:30 on from its deltas' books.
        assert.strictEqual(answer.through, "14:21:30")
        assert.deepStrictEqual(answer.slices, [
          ...minute1420,
          // The open chunk starts from the book in force at 14:21.
          [
            "14:21:00",
            [
              [8_000, 90, 0],
              [8_025, 0, 40],
            ],
          ],
          [
            "14:21:10",
            [
              [8_000, 90, 0],
              [8_025, 0, 40],
            ],
          ],
          // 40 lots for 2.5 s, then 20 for 7.5 s: 25.
          [
            "14:21:20",
            [
              [8_000, 90, 0],
              [8_025, 0, 25],
            ],
          ],
        ])
      })
  )

  it.effect(
    "a live GET before the minute's flush answers its held chunk's whole slices",
    () =>
      Effect.gen(function* () {
        const day = yield* bookMinute1420
        yield* at("14:20:59.999")
        const before = yield* heatmap(day)
        assert.strictEqual(before.through, "14:20:50")
        assert.deepStrictEqual(before.slices, minute1420.slice(0, 5))
        // Its minute is over, its flush not yet run.
        yield* at("14:21:03.000")
        const after = yield* heatmap(day)
        assert.strictEqual(after.through, "14:21:00")
        assert.deepStrictEqual(after.slices, minute1420)
      })
  )

  it.effect(
    "a sealed day's GET answers every stored slice, cached immutable",
    () =>
      Effect.gen(function* () {
        const day = yield* bookDay
        yield* at("17:00:00")
        yield* day.alarm
        const answer = yield* heatmap(day)
        assert.strictEqual(answer.cacheControl, SEALED_CACHE)
        // The seal closed 14:21's chunk; no frame came after it.
        assert.strictEqual(answer.through, "14:22:00")
        assert.deepStrictEqual(answer.slices.slice(0, 6), minute1420)
        assert.deepStrictEqual(
          answer.slices.slice(6).map(([time]) => time),
          [
            "14:21:00",
            "14:21:10",
            "14:21:20",
            "14:21:30",
            "14:21:40",
            "14:21:50",
          ]
        )
        assert.deepStrictEqual(answer.slices.at(-1), [
          "14:21:50",
          [
            [8_000, 90, 0],
            [8_025, 0, 20],
          ],
        ])
      })
  )

  it.effect("is a recorded day path, so it is gated like the others", () =>
    Effect.gen(function* () {
      const date = WibDate.make("2026-11-09")
      const path = yield* recordedDayPath(date, {
        _tag: "Heatmap",
        code: UNTR,
      })
      assert.strictEqual(path, "/market-live/days/2026-11-09/heatmap/UNTR")
      const request = yield* recordedDayRequest({ pathname: path, search: "" })
      assert.deepStrictEqual(Option.getOrUndefined(request), {
        date,
        resource: { _tag: "Heatmap", code: UNTR },
      })
    })
  )
})
