// Seam (1) of spec apinrdw/kumora#263 for the footprint (ticket
// apinrdw/kumora#264): Stockbit trades go in through the ingest socket, time
// moves only by TestClock, and the test reads the footprints viewers are
// sent and the recorded day answers. The page tests hear the socket through
// the page's own candle store: whatever reaches the day, the page's candles
// and footprints are a fresh snapshot's.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  ViewerCloseCode,
  ViewerProtocolVersion,
  decodeViewerDown,
  type Candle,
  type Footprint,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { SEALED_CACHE } from "@/server/market-live/routes"

import {
  ajaibTrade,
  cellsOf,
  footprintsOf,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { memorySql } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

// UNTR's opening match and its first minutes of session 1, with a negotiated
// block and a cash-board print that the footprint leaves out.
const session = [
  // The opening match: no aggressor side, whatever a feed claims.
  stockbitTrade({ number: 662, time: "08:58:00.000", price: 23200, lots: 50 }),
  stockbitTrade({
    number: 663,
    time: "08:58:00.000",
    price: 23200,
    lots: 4,
    side: "sell",
  }),
  stockbitTrade({
    number: 40001,
    time: "09:00:10.000",
    price: 23300,
    lots: 2,
    side: "buy",
  }),
  stockbitTrade({
    number: 40002,
    time: "09:00:20.000",
    price: 23150,
    lots: 1,
    side: "sell",
  }),
  stockbitTrade({
    number: 40003,
    time: "09:00:25.000",
    price: 23150,
    lots: 4,
    side: "buy",
  }),
  stockbitTrade({
    number: 40004,
    time: "09:00:30.000",
    price: 30000,
    lots: 500,
    side: "buy",
    board: "NG",
  }),
  stockbitTrade({
    number: 40005,
    time: "09:00:40.000",
    price: 10000,
    lots: 1,
    side: "buy",
    board: "TN",
  }),
  stockbitTrade({
    number: 40006,
    time: "09:01:05.000",
    price: 23275,
    lots: 1,
    side: "sell",
  }),
]

const sessionFootprints = [
  { minute: "2026-11-09T01:58:00.000Z", cells: [[23200, 0, 0, 54]] },
  {
    minute: "2026-11-09T02:00:00.000Z",
    cells: [
      [23150, 1, 4, 0],
      [23300, 0, 2, 0],
    ],
  },
  { minute: "2026-11-09T02:01:00.000Z", cells: [[23275, 1, 0, 0]] },
]

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// A code's candles and footprints as a test compares them: each candle as
// [minute in ISO, open, high, low, close, volume, frequency].
const viewOf = (
  candles: ReadonlyArray<Candle>,
  footprints: ReadonlyArray<Footprint>
) => ({
  candles: candles.map((candle) => [
    DateTime.formatIso(candle.minute),
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.frequency,
  ]),
  footprints: footprints.map(cellsOf),
})

// A Market Live page on `code`: its candle store hears what the object sends
// its socket.
const pageOn = Effect.fnUntraced(function* (day: Day, code: string) {
  const socket = yield* day.viewer(code)
  const store = yield* makeCandleStore(StockCode.make(code))
  let heard = 0
  // The store reads every message sent since it last heard.
  const hear = Effect.gen(function* () {
    for (const text of socket.sent.slice(heard))
      store.apply(yield* decodeViewerDown(text))
    heard = socket.sent.length
  })
  return { hear, view: () => viewOf(store.candles(), store.footprints()) }
})

// A fresh snapshot's candles and footprints of `code`: what the page's must
// be.
const fresh = Effect.fnUntraced(function* (day: Day, code: string) {
  const socket = yield* day.viewer(code)
  const [snapshot] = yield* socket.received
  yield* day.left(socket)
  assert.strictEqual(snapshot?._tag, "Snapshot")
  return viewOf(snapshot?.candles ?? [], snapshot?.footprints ?? [])
})

// The stored day's candles and footprints of `code`, as a recorded day load
// reads them.
const stored = Effect.fnUntraced(function* (day: Day, code: string) {
  const { answer } = yield* day.recordedCandles(code)
  return viewOf(answer.candles, answer.footprints ?? [])
})

describe("footprints", () => {
  it.effect(
    "the snapshot carries the selected code's footprints so far: regular-board lots by price and aggressor side, the auction match as no-side lots",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades(session)
        const page = yield* day.viewer("UNTR")
        const [snapshot] = yield* page.received
        assert.deepStrictEqual(
          footprintsOf([snapshot!], "UNTR").map(cellsOf),
          sessionFootprints
        )
      })
  )

  it.effect(
    "a delta carries each changed minute whole, of a selected code only; a late trade resends its own minute",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* day.viewer("UNTR")
        const [first, ...rest] = session.slice(2)
        yield* day.trades([
          ...rest,
          // Another code's trade, which no viewer selected.
          stockbitTrade({
            number: 40007,
            time: "09:01:06.000",
            code: "BBCA",
            price: 8000,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* day.trades([first!])
        yield* TestClock.adjust("250 millis")
        const [, before, after] = yield* page.received
        assert.deepStrictEqual(footprintsOf([before!], "UNTR").map(cellsOf), [
          {
            minute: "2026-11-09T02:00:00.000Z",
            cells: [[23150, 1, 4, 0]],
          },
          { minute: "2026-11-09T02:01:00.000Z", cells: [[23275, 1, 0, 0]] },
        ])
        assert.deepStrictEqual(footprintsOf([before!], "BBCA"), [])
        // Only 09:00's footprint, whole, with the late trade's lots.
        assert.deepStrictEqual(footprintsOf([after!], "UNTR").map(cellsOf), [
          sessionFootprints[1],
        ])
      })
  )

  it.effect(
    "a late trade in a minute already stored resends that minute with its stored lots and its own",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        yield* day.trades(session)
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        const page = yield* day.viewer("UNTR")
        yield* day.trades([
          stockbitTrade({
            number: 40008,
            time: "09:00:50.000",
            price: 23300,
            lots: 3,
            side: "sell",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        const [, delta] = yield* page.received
        assert.deepStrictEqual(footprintsOf([delta!], "UNTR").map(cellsOf), [
          {
            minute: "2026-11-09T02:00:00.000Z",
            cells: [
              [23150, 1, 4, 0],
              [23300, 3, 2, 0],
            ],
          },
        ])
      })
  )

  it.effect(
    "a restarted object serves the stored footprints, and a recorded day load carries them with the candles, cached once sealed",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades(session)
        yield* TestClock.adjust("2 minutes")

        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("UNTR")
        const [snapshot] = yield* page.received
        assert.deepStrictEqual(
          footprintsOf([snapshot!], "UNTR").map(cellsOf),
          sessionFootprints
        )
        const live = yield* restarted.recordedCandles("UNTR")
        assert.strictEqual(live.cacheControl, "no-store")
        assert.deepStrictEqual(
          (live.answer.footprints ?? []).map(cellsOf),
          sessionFootprints
        )

        // Gone before the seal: a viewer's 250 ms deltas would replay the
        // hours to it.
        yield* restarted.left(page)
        yield* at("17:00:00")
        yield* restarted.alarm
        const sealed = yield* restarted.recordedCandles("UNTR")
        assert.strictEqual(sealed.cacheControl, SEALED_CACHE)
        assert.deepStrictEqual(
          (sealed.answer.footprints ?? []).map(cellsOf),
          sessionFootprints
        )
      })
  )
})

describe("the page's candles and footprints", () => {
  it.effect(
    "a minute's only trade, moved off the regular board by Stockbit inside its merge window, leaves the page as it leaves a fresh snapshot and the stored day",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:10",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // The only trade of its minute.
          ajaibTrade({
            number: 40002,
            time: "09:01:05",
            price: 23325,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.hear
        assert.deepStrictEqual(page.view().footprints, [
          { minute: "2026-11-09T02:00:00.000Z", cells: [[23300, 0, 2, 0]] },
          { minute: "2026-11-09T02:01:00.000Z", cells: [[23325, 0, 3, 0]] },
        ])
        // Stockbit names it a cash-board trade.
        yield* day.trades([
          stockbitTrade({
            number: 40002,
            time: "09:01:05.000",
            price: 23325,
            lots: 3,
            side: "buy",
            board: "TN",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.hear
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(whole, {
          candles: [
            ["2026-11-09T02:00:00.000Z", 23300, 23300, 23300, 23300, 2, 1],
          ],
          footprints: [
            { minute: "2026-11-09T02:00:00.000Z", cells: [[23300, 0, 2, 0]] },
          ],
        })
        assert.deepStrictEqual(page.view(), whole)
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* page.hear
        assert.deepStrictEqual(yield* stored(day, "UNTR"), whole)
        assert.deepStrictEqual(page.view(), whole)
      })
  )

  it.effect(
    "a minute's only trade, moved into the minute before by Stockbit's time, leaves the page as it leaves a fresh snapshot and the stored day",
    () =>
      Effect.gen(function* () {
        yield* at("09:01:10")
        const day = yield* tradingDay()
        const page = yield* pageOn(day, "UNTR")
        yield* day.ajaibTrades([
          ajaibTrade({
            number: 40001,
            time: "09:00:59",
            price: 23300,
            lots: 2,
            side: "buy",
          }),
          // Ajaib rounds 09:00:59.900 up.
          ajaibTrade({
            number: 40002,
            time: "09:01:00",
            price: 23325,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.hear
        assert.lengthOf(page.view().footprints, 2)
        yield* day.trades([
          stockbitTrade({
            number: 40002,
            time: "09:00:59.900",
            price: 23325,
            lots: 3,
            side: "buy",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        yield* page.hear
        const whole = yield* fresh(day, "UNTR")
        assert.deepStrictEqual(whole, {
          candles: [
            ["2026-11-09T02:00:00.000Z", 23300, 23325, 23300, 23325, 5, 2],
          ],
          footprints: [
            {
              minute: "2026-11-09T02:00:00.000Z",
              cells: [
                [23300, 0, 2, 0],
                [23325, 0, 3, 0],
              ],
            },
          ],
        })
        assert.deepStrictEqual(page.view(), whole)
        // Past the merge window and the minute's flush.
        yield* TestClock.adjust("2 minutes")
        yield* page.hear
        assert.deepStrictEqual(yield* stored(day, "UNTR"), whole)
        assert.deepStrictEqual(page.view(), whole)
      })
  )
})

describe("the viewer protocol", () => {
  it.effect("version 10 is served; a version 9 page is closed with 4426", () =>
    Effect.gen(function* () {
      assert.strictEqual(ViewerProtocolVersion, 10)
      const day = yield* tradingDay()
      const current = yield* day.viewer("UNTR")
      assert.lengthOf(current.sent, 1)
      const old = yield* day.viewer("UNTR", 9)
      assert.strictEqual(old.closedWith, ViewerCloseCode.NewVersion)
      assert.lengthOf(old.sent, 0)
    })
  )
})
