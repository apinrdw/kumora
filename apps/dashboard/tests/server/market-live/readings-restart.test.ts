// Book readings across a restart (spec apinrdw/kumora#517, "Data"): outside
// Sessions 1 and 2 each code keeps its last session's readings, and a
// restarted object's snapshots keep them too.
import { assert, describe, it } from "@effect/vitest"
import { decodeViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitBook, tradingDay } from "./day-harness"
import { memorySql } from "./sql"

const at = (time: string) =>
  TestClock.setTime(Date.parse(`2026-11-09T${time}+07:00`))

const wibTime = (instant: DateTime.Utc) =>
  DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(11, 19)

// `code`'s book as of `time`: bids from `best` down, two offers above it.
const bookOf = (code: string, time: string, best: number) => [
  stockbitBook({
    code,
    side: "BID",
    time,
    levels: [
      [best, 10, 1000],
      [best - 25, 10, 1000],
    ],
  }),
  stockbitBook({
    code,
    side: "OFFER",
    time,
    levels: [
      [best + 25, 10, 900],
      [best + 50, 10, 900],
    ],
  }),
]
const untrBook = (time: string, best: number) => bookOf("UNTR", time, best)

describe("book readings after a restart", () => {
  it.effect(
    "keep the last session's when the book changed in the break before the restart",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("11:00:00.000")
        const day = yield* tradingDay(sql)
        yield* day.frames(untrBook("11:00:00.000", 23_300))
        yield* TestClock.adjust("1 second")
        // Flushed 5 s past the minute.
        yield* at("11:01:06.000")
        yield* TestClock.adjust("1 second")
        // 12:05, the break: the book changes again.
        yield* at("12:05:00.000")
        yield* day.frames(untrBook("12:05:00.000", 23_275))
        yield* TestClock.adjust("1 second")
        yield* at("12:06:06.000")
        yield* TestClock.adjust("1 second")
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("UNTR")
        const snapshot = yield* decodeViewerDown(page.sent[0]!)
        assert(snapshot._tag === "Snapshot")
        assert.deepStrictEqual(
          (snapshot.bookReadings ?? []).map((readings) => [
            readings.code,
            wibTime(readings.at),
          ]),
          [["UNTR", "11:00:00"]],
          "the restarted object's snapshot keeps UNTR's Session 1 readings"
        )
      })
  )

  it.effect(
    "are kept at a session's end as one row per code with a book, the codes' last in the session",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        yield* at("11:58:00.000")
        const day = yield* tradingDay(sql)
        yield* day.frames(untrBook("11:58:00.000", 23_300))
        yield* day.frames(bookOf("BBCA", "11:58:00.000", 8_000))
        yield* TestClock.adjust("1 second")
        yield* at("11:59:30.000")
        yield* day.frames(untrBook("11:59:30.000", 23_275))
        yield* TestClock.adjust("1 second")
        const kept = () =>
          sql
            .exec("SELECT code FROM session_books ORDER BY code")
            .map((row) => row.code)
        assert.deepStrictEqual(kept(), [], "none while Session 1 runs")
        // Flushed 5 s past 12:00, the break.
        yield* at("12:00:06.000")
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(kept(), ["BBCA", "UNTR"])
        yield* day.evicted
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("UNTR")
        const snapshot = yield* decodeViewerDown(page.sent[0]!)
        assert(snapshot._tag === "Snapshot")
        assert.deepStrictEqual(
          (snapshot.bookReadings ?? [])
            .map((readings) => [readings.code, wibTime(readings.at)])
            .sort(([a], [b]) => (a < b ? -1 : 1)),
          [
            ["BBCA", "11:58:00"],
            ["UNTR", "11:59:30"],
          ],
          "the restarted object's snapshot keeps each code's last Session 1 readings"
        )
      })
  )
})
