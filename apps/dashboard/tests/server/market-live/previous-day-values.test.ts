// The previous trading day's values (spec apinrdw/kumora#517, "Data"):
// today's trading-day object asks the previous sealed day's object once a
// day for every code's regular-board value, keeps it for the day and sends
// it with each snapshot; after a gap the previous day has none.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  ViewerProtocolVersion,
  WibDate,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import { makeFiguresStore } from "@/components/order-book-radar/figures-store"
import type { Sql } from "@/server/market-live/day-store"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import { stockbitTrade, tradingDay } from "./day-harness"
import { messageField, stringField } from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const TODAY = WibDate.make("2026-11-10")

const env = Layer.succeed(WorkerEnv)({
  INGEST_TOKEN: TOKEN,
} as unknown as WorkerEnv["Service"])

const at = (instant: string) => TestClock.setTime(Date.parse(instant))

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
}

// Stockbit's `order_book` frame of one side of UNTR's book today.
const untrSide = (side: "BID" | "OFFER", price: number) =>
  Uint8Array.from(
    messageField(10, [
      ...stringField(1, "UNTR"),
      ...stringField(2, `#O|UNTR|${side}|${price};2;20000|0-1&20000`),
      ...stringField(5, "2026-11-10T09:00:30.000+07:00"),
    ])
  )

// 2026-11-09, the previous trading day: UNTR trades Rp4,660,000 and the day
// is sealed at 17:00 unless `sealed` is false.
const previousDay = Effect.fnUntraced(function* (sealed: boolean) {
  const sql = memorySql()
  yield* at("2026-11-09T15:49:50+07:00")
  const day = yield* tradingDay(sql)
  yield* day.trades([
    stockbitTrade({
      number: 40001,
      time: "15:49:50",
      code: "UNTR",
      price: 23300,
      lots: 2,
      side: "buy",
    }),
  ])
  yield* at("2026-11-09T17:00:00+07:00")
  if (sealed) yield* day.alarm
  else yield* day.evicted
  return sql
})

// Today's object on `sql`, at 09:00:30, reaching earlier days' objects
// through `days` (each restarted on its own store), and counting its asks.
const today = Effect.fnUntraced(function* (
  sql: Sql,
  days: ReadonlyMap<WibDate, Sql>,
  asked: Array<WibDate>
) {
  yield* at("2026-11-10T09:00:30+07:00")
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql,
    date: TODAY,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    previousDayValues: (date) =>
      Effect.gen(function* () {
        asked.push(date)
        const stored = days.get(date) ?? memorySql()
        const earlier = yield* makeTradingDay({
          sql: stored,
          date,
          viewers: Effect.succeed([]),
          viewersOf: () => Effect.succeed([]),
        }).pipe(Scope.provide(scope))
        return yield* earlier.dayValues
      }),
  }).pipe(Scope.provide(scope))
  // The relay connects: its token, then UNTR's book.
  const relay = new FakeSocket()
  const ingest = (text: string) =>
    day.ingestMessage(relay, text).pipe(Effect.provide(env))
  yield* ingest(
    yield* encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
  )
  yield* ingest(
    yield* encodeIngestUp({
      _tag: "Frames",
      protocolVersion: IngestProtocolVersion,
      feed: "Stockbit",
      connection: "A",
      receivedAt: yield* DateTime.now,
      frames: [untrSide("BID", 23300), untrSide("OFFER", 23325)],
    })
  )
  yield* TestClock.adjust("1 second")
  // A page's snapshot: UNTR's scanner figures.
  const untrFigures = Effect.gen(function* () {
    const page = new FakeSocket()
    yield* day.viewerMessage(
      page,
      yield* encodeViewerUp({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make("IHSG"),
        watchlist: [],
      })
    )
    const snapshot = yield* decodeViewerDown(page.sent[0]!)
    assert(snapshot._tag === "Snapshot")
    return snapshot.scannerFigures?.find((each) => each.code === "UNTR")
  })
  return { untrFigures, scope }
})

describe("the previous trading day's values", () => {
  it.effect(
    "come from the previous sealed day once a day, and ride every snapshot",
    () =>
      Effect.gen(function* () {
        const days = new Map([
          [WibDate.make("2026-11-09"), yield* previousDay(true)],
        ])
        const asked: Array<WibDate> = []
        const sql = memorySql()
        const live = yield* today(sql, days, asked)
        // 2 lots at 23,300.
        assert.strictEqual((yield* live.untrFigures)?.previousValue, 4_660_000)
        assert.strictEqual((yield* live.untrFigures)?.previousValue, 4_660_000)
        // The object restarts and the relay connects again: kept, not asked.
        const restarted = yield* today(sql, days, asked)
        assert.strictEqual(
          (yield* restarted.untrFigures)?.previousValue,
          4_660_000
        )
        assert.deepStrictEqual(asked, ["2026-11-09"])
      })
  )

  it.effect(
    "reach a page that connected before the code's first book, with its first readings",
    () =>
      Effect.gen(function* () {
        const days = new Map([
          [WibDate.make("2026-11-09"), yield* previousDay(true)],
        ])
        yield* at("2026-11-10T09:00:30+07:00")
        const scope = yield* Scope.make()
        const page = new FakeSocket()
        const day = yield* makeTradingDay({
          sql: memorySql(),
          date: TODAY,
          viewers: Effect.succeed([page]),
          viewersOf: () => Effect.succeed([]),
          previousDayValues: (date) =>
            Effect.gen(function* () {
              const earlier = yield* makeTradingDay({
                sql: days.get(date) ?? memorySql(),
                date,
                viewers: Effect.succeed([]),
                viewersOf: () => Effect.succeed([]),
              }).pipe(Scope.provide(scope))
              return yield* earlier.dayValues
            }),
        }).pipe(Scope.provide(scope))
        const relay = new FakeSocket()
        const ingest = (text: string) =>
          day.ingestMessage(relay, text).pipe(Effect.provide(env))
        yield* ingest(
          yield* encodeIngestUp({
            _tag: "Token",
            protocolVersion: IngestProtocolVersion,
            token: TOKEN,
          })
        )
        // The page connects while no code has a book yet.
        yield* day.viewerMessage(
          page,
          yield* encodeViewerUp({
            _tag: "Select",
            protocolVersion: ViewerProtocolVersion,
            selected: StockCode.make("IHSG"),
            watchlist: [],
          })
        )
        yield* ingest(
          yield* encodeIngestUp({
            _tag: "Frames",
            protocolVersion: IngestProtocolVersion,
            feed: "Stockbit",
            connection: "A",
            receivedAt: yield* DateTime.now,
            frames: [untrSide("BID", 23300), untrSide("OFFER", 23325)],
          })
        )
        yield* TestClock.adjust("1 second")
        // What the scanner holds from every message the page was sent.
        const figures = yield* makeFiguresStore
        for (const text of page.sent)
          figures.apply(yield* decodeViewerDown(text))
        assert.strictEqual(
          figures.all().get(StockCode.make("UNTR"))?.previousValue,
          4_660_000,
          "UNTR's previous day's value reached the page with its first readings"
        )
      })
  )

  it.effect("are missing after a gap, and not asked again that day", () =>
    Effect.gen(function* () {
      // The relay never sealed 2026-11-09.
      const days = new Map([
        [WibDate.make("2026-11-09"), yield* previousDay(false)],
      ])
      const asked: Array<WibDate> = []
      const sql = memorySql()
      const live = yield* today(sql, days, asked)
      const figures = yield* live.untrFigures
      assert.isDefined(figures)
      assert.isUndefined(figures?.previousValue)
      yield* today(sql, days, asked)
      assert.deepStrictEqual(asked, ["2026-11-09"])
    })
  )

  it.effect("skip a weekend back to Friday", () =>
    Effect.gen(function* () {
      const asked: Array<WibDate> = []
      yield* at("2026-11-09T09:00:30+07:00")
      const scope = yield* Scope.make()
      const day = yield* makeTradingDay({
        sql: memorySql(),
        date: WibDate.make("2026-11-09"),
        viewers: Effect.succeed([]),
        viewersOf: () => Effect.succeed([]),
        previousDayValues: (date) =>
          Effect.sync(() => {
            asked.push(date)
            return new Response(null, { status: 404 })
          }),
      }).pipe(Scope.provide(scope))
      yield* day
        .ingestMessage(
          new FakeSocket(),
          yield* encodeIngestUp({
            _tag: "Token",
            protocolVersion: IngestProtocolVersion,
            token: TOKEN,
          })
        )
        .pipe(Effect.provide(env))
      assert.deepStrictEqual(asked, ["2026-11-06"])
    })
  )
})
