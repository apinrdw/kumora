// Today's object after its seal (apinrdw/kumora#589): it restores the live
// day only once something needs it, so the evening's broker codes rechecks,
// each on a freshly woken object, never read it.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  ViewerProtocolVersion,
  decodeViewerDown,
  encodeViewerUp,
  WibDate,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "@/server/market-live/day-store"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import { stockbitTrade, tradingDay } from "./day-harness"
import { counted, memorySql } from "./sql"

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

// More trades than anything but the restore reads.
const TRADES = 600

// A relay day of TRADES trades of UNTR, sealed at 17:00, on counted SQL.
// Returns the day as it ran, still today.
const sealedDay = Effect.fnUntraced(function* (sql: Sql) {
  yield* at("15:50:00")
  const day = yield* tradingDay(sql)
  yield* day.trades(
    Array.from({ length: TRADES }, (_, index) =>
      stockbitTrade({
        number: 50_001 + index,
        time: `15:4${Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}`,
        price: 23_000 + (index % 7) * 25,
        lots: 1 + (index % 5),
        side: index % 2 === 0 ? "buy" : "sell",
      })
    )
  )
  yield* at("17:00:00")
  yield* day.alarm
  return day
})

// The object woken again on `sql` with no socket: no relay token, as after
// hibernation in the evening.
const woken = (sql: Sql) =>
  makeTradingDay({
    sql,
    date: WibDate.make("2026-11-09"),
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
  })

class Viewer implements Peer {
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  open = Effect.succeed(true)
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
}

// The snapshot a new viewer of UNTR is sent, as a page compares it.
const snapshotOf = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof makeTradingDay>>
) {
  const viewer = new Viewer()
  yield* day.viewerMessage(
    viewer,
    yield* encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: StockCode.make("UNTR"),
      watchlist: [],
    })
  )
  const snapshot: ViewerDown = yield* decodeViewerDown(viewer.sent[0]!)
  return {
    tape: snapshot.tape,
    candles: snapshot.candles,
    footprints: snapshot.footprints,
    dayStates: snapshot.dayStates,
    bookReadings: snapshot.bookReadings,
    scannerFigures: snapshot.scannerFigures,
  }
})

// Today's day answers its bubbles and statuses without reading a binding.
const noBindings = Layer.succeed(WorkerEnv)({} as WorkerEnv["Service"])

const rowsRead = (sql: Sql) => sql.usage!().rowsRead

const bubblesText = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof makeTradingDay>>
) {
  const response = yield* day
    .recorded({ _tag: "Bubbles" })
    .pipe(Effect.provide(noBindings))
  assert.strictEqual(response.status, 200)
  return yield* Effect.promise(() => response.text())
})

describe("today's sealed day", () => {
  it.effect(
    "a woken object answers a broker codes status without reading the live day",
    () =>
      Effect.gen(function* () {
        const sql = counted(memorySql())
        yield* sealedDay(sql)
        yield* at("19:00:00")
        const before = rowsRead(sql)
        const day = yield* woken(sql).pipe(Scope.provide(yield* Scope.make()))
        const response = yield* day.brokerCodes
          .status(new URLSearchParams())
          .pipe(Effect.provide(noBindings))
        assert.strictEqual(response.status, 200)
        // The restore reads the tape, TRADES rows, and the day's candles.
        assert.isBelow(rowsRead(sql) - before, TRADES / 2)
      })
  )

  it.effect(
    "a woken object sends a viewer the snapshot the day held at its seal, and restores once",
    () =>
      Effect.gen(function* () {
        const sql = counted(memorySql())
        const running = yield* sealedDay(sql)
        yield* at("19:00:00")
        const held = yield* snapshotOf(running.day)
        const day = yield* woken(sql).pipe(Scope.provide(yield* Scope.make()))
        assert.deepStrictEqual(yield* snapshotOf(day), held)
        const before = rowsRead(sql)
        assert.deepStrictEqual(yield* snapshotOf(day), held)
        assert.isBelow(rowsRead(sql) - before, TRADES / 2)
      })
  )

  it.effect("a woken object answers the bubbles the day held at its seal", () =>
    Effect.gen(function* () {
      const sql = counted(memorySql())
      const running = yield* sealedDay(sql)
      yield* at("19:00:00")
      const held = yield* bubblesText(running.day)
      const day = yield* woken(sql).pipe(Scope.provide(yield* Scope.make()))
      assert.strictEqual(yield* bubblesText(day), held)
    })
  )
})
