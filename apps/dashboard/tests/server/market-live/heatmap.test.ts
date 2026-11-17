// Seam (1) of spec apinrdw/kumora#263 for the book heatmap (ticket
// apinrdw/kumora#267): Stockbit order book frames go in through the ingest
// socket, time moves only by TestClock, and the test reads the heatmap GET's
// answers. The page tests join them to the socket's order books through the
// page's own heatmap store: whatever the book did, the page's slices are a
// fresh GET's.
import { assert, describe, it } from "@effect/vitest"
import {
  HEAT_SLICE_MS,
  StockCode,
  WibDate,
  decodeRecordedHeatmap,
  decodeViewerDown,
  recordedDayPath,
  recordedDayRequest,
  type HeatSlice,
} from "@workspace/relay"
import { Clock, DateTime, Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeHeatmapStore } from "@/components/market-live/heatmap-store"
import type { Sql } from "@/server/market-live/day-store"
import { SEALED_CACHE } from "@/server/market-live/routes"

import {
  sealedBeforeOrderFlow,
  stockbitBook,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
// A frame sent at `time` is served with the delta 250 ms later.
const SERVED_AFTER = "250 millis"

const UNTR = StockCode.make("UNTR")
const DAY = WibDate.make("2026-11-09")

type Day = Effect.Success<ReturnType<typeof tradingDay>>

const wibTime = (instant: DateTime.Utc) =>
  DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(11, 19)

// A slice as a test compares it: [WIB time, levels].
const sliceOf = (slice: HeatSlice): ReadonlyArray<unknown> => [
  wibTime(slice.at),
  slice.levels.map((level) => [...level]),
]

// The heatmap GET's answer for UNTR, with its Cache-Control.
const answerOf = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({ _tag: "Heatmap", code: UNTR })
  return {
    cacheControl: response.headers.get("Cache-Control"),
    answer: yield* decodeRecordedHeatmap(
      yield* Effect.promise(() => response.text())
    ),
  }
})

// That answer as a test compares it: its Cache-Control, the slice time it
// answers up to, and each slice.
const heatmap = Effect.fnUntraced(function* (day: Day) {
  const { cacheControl, answer } = yield* answerOf(day)
  return {
    cacheControl,
    code: answer.code,
    through: wibTime(answer.through),
    slices: answer.slices.map(sliceOf),
  }
})

// A Market Live page on UNTR: its heatmap store hears what the object sends
// its socket and reads the object's clock, and the heatmap GET answers what
// the store asks.
const pageOn = Effect.fnUntraced(function* (day: Day) {
  const clock = yield* Clock.Clock
  const store = yield* makeHeatmapStore(UNTR, DAY, () =>
    clock.currentTimeMillisUnsafe()
  )
  const socket = yield* day.viewer("UNTR")
  let heard = 0
  // The store reads every message sent since it last heard, gets the answer
  // it asked for, and its timer ticks.
  const hear = Effect.gen(function* () {
    for (const text of socket.sent.slice(heard))
      store.apply(yield* decodeViewerDown(text))
    heard = socket.sent.length
    const asked = store.awaiting()
    if (asked !== undefined) store.answer(asked, (yield* answerOf(day)).answer)
    store.tick()
  })
  yield* hear
  return {
    hear,
    // Its socket closes; its timer still ticks.
    leave: day.left(socket),
    slices: () => store.slices().map(sliceOf),
  }
})

// UNTR's book on 2026-11-09: 50 lots bid at 8,000 and 40 offered at 8,025,
// served at 14:20:04; the bid grows to 90 at 14:20:15.
const bookMinute1420 = Effect.gen(function* () {
  yield* at("14:20:03.750")
  const day = yield* tradingDay()
  yield* day.trades([RELAYED])
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

// A trade of another code, so the relay records the day.
const RELAYED = stockbitTrade({
  number: 1,
  time: "14:20:00.000",
  code: "BBCA",
  price: 8_000,
  lots: 1,
})

// `count` slices from `from`, each the book resting 90 lots bid at 8,000 and
// `offer` at 8,025.
const resting = (from: string, count: number, offer: number) =>
  Array.from({ length: count }, (_, index) => [
    wibTime(
      DateTime.makeUnsafe(
        DateTime.toEpochMillis(wib(from)) + index * HEAT_SLICE_MS
      )
    ),
    [
      [8_000, 90, 0],
      [8_025, 0, offer],
    ],
  ])

// A page watching UNTR from 14:20:00, a slice start, so its estimate of the
// object's clock is exact. The book is served at 14:20:04 and its bid grows
// at 14:20:15, as in `bookMinute1420`; then no frame comes.
const quietDay = Effect.fnUntraced(function* (sql: Sql = memorySql()) {
  yield* at("14:20:00.000")
  const day = yield* tradingDay(sql)
  yield* day.trades([RELAYED])
  const page = yield* pageOn(day)
  yield* at("14:20:03.750")
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[8_000, 3, 50]], time: "14:20:03" }),
    stockbitBook({ side: "OFFER", levels: [[8_025, 2, 40]], time: "14:20:03" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
  yield* page.hear
  yield* at("14:20:14.750")
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[8_000, 5, 90]], time: "14:20:14" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
  yield* page.hear
  return { day, page }
})

// At 14:23:45, after two minutes with no frame, the offer drops to 20.
const offerDrops = Effect.fnUntraced(function* (day: Day) {
  yield* at("14:23:44.750")
  yield* day.frames([
    stockbitBook({ side: "OFFER", levels: [[8_025, 1, 20]], time: "14:23:44" }),
  ])
  yield* TestClock.adjust(SERVED_AFTER)
})

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
    "a sealed day's GET answers every stored slice, then its last book to the end of the relay's streaming, cached immutable",
    () =>
      Effect.gen(function* () {
        const day = yield* bookDay
        yield* at("17:00:00")
        yield* day.alarm
        const answer = yield* heatmap(day)
        assert.strictEqual(answer.cacheControl, SEALED_CACHE)
        assert.strictEqual(answer.through, "16:35:00")
        assert.deepStrictEqual(answer.slices.slice(0, 6), minute1420)
        // The seal closed 14:21's chunk.
        assert.deepStrictEqual(answer.slices.slice(6, 12), [
          ...resting("14:21:00", 2, 40),
          // 40 lots for 2.5 s, then 20 for 7.5 s.
          ...resting("14:21:20", 1, 25),
          ...resting("14:21:30", 3, 20),
        ])
        // No frame came after it.
        assert.deepStrictEqual(
          answer.slices.slice(12),
          resting("14:22:00", 798, 20)
        )
      })
  )

  it.effect(
    "a minute with no frame keeps the book before it: a page that watched it, a page that joins after it and a fresh GET show the same slices",
    () =>
      Effect.gen(function* () {
        const { day, page } = yield* quietDay()
        // 14:21 and 14:22 passed with no frame. A slice start again.
        yield* at("14:23:40.000")
        yield* page.hear
        const joined = yield* pageOn(day)
        const whole = yield* heatmap(day)
        assert.strictEqual(whole.through, "14:23:40")
        assert.deepStrictEqual(whole.slices, [
          ...minute1420,
          ...resting("14:21:00", 16, 40),
        ])
        // A page's last slice is the one still running.
        assert.deepStrictEqual(page.slices().slice(0, -1), whole.slices)
        assert.deepStrictEqual(joined.slices(), page.slices())

        yield* offerDrops(day)
        yield* page.hear
        yield* joined.hear
        // 14:24 passed with no frame.
        yield* at("14:25:10.000")
        yield* page.hear
        yield* joined.hear
        const later = yield* heatmap(day)
        assert.strictEqual(later.through, "14:25:10")
        assert.deepStrictEqual(later.slices, [
          ...whole.slices,
          // 40 lots for 5 s, then 20 for 5 s.
          ...resting("14:23:40", 1, 30),
          ...resting("14:23:50", 8, 20),
        ])
        assert.deepStrictEqual(page.slices().slice(0, -1), later.slices)
        assert.deepStrictEqual(joined.slices(), page.slices())
      })
  )

  it.effect(
    "a minute whose flush failed still answers its slices and the quiet minute's after it",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        let down = false
        const { day, page } = yield* quietDay({
          ...sql,
          transaction: (write) => {
            // The storage API is synchronous and throws.
            if (down)
              return Effect.runSync(Effect.fail(new Error("Storage down")))
            sql.transaction(write)
          },
        })
        // The 14:21:05 flush fails: 14:20's chunk waits for the next one.
        down = true
        yield* at("14:21:40.000")
        yield* page.hear
        const whole = yield* heatmap(day)
        assert.deepStrictEqual(whole.slices, [
          ...minute1420,
          ...resting("14:21:00", 4, 40),
        ])
        assert.deepStrictEqual(page.slices().slice(0, -1), whole.slices)
      })
  )

  it.effect(
    "a sealed day answers its quiet minutes to the end of the relay's streaming, as the page that watched them showed and as the one-off build answers",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        const { day, page } = yield* quietDay(sql)
        yield* offerDrops(day)
        yield* page.hear
        // Gone before the seal: a viewer's 250 ms deltas would replay the
        // hours to it.
        yield* page.leave
        yield* at("17:00:00")
        yield* page.hear
        yield* day.alarm
        const sealed = yield* heatmap(day)
        assert.strictEqual(sealed.cacheControl, SEALED_CACHE)
        assert.strictEqual(sealed.through, "16:35:00")
        assert.deepStrictEqual(sealed.slices, [
          ...minute1420,
          ...resting("14:21:00", 16, 40),
          ...resting("14:23:40", 1, 30),
          // To 16:35, where the relay stops streaming.
          ...resting("14:23:50", 787, 20),
        ])
        assert.deepStrictEqual(sealed.slices.at(-1)?.[0], "16:34:50")
        assert.deepStrictEqual(page.slices(), sealed.slices)

        yield* day.evicted
        yield* sealedBeforeOrderFlow(sql)
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-11-10T10:00:00+07:00")
          )
        )
        const built = yield* heatmap(yield* tradingDay(sql))
        assert.deepStrictEqual(built, sealed)
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
