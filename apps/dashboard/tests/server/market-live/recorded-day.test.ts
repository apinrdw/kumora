// Seam (a) of spec apinrdw/kumora#138, for storage, the seal and recorded day
// loads: envelopes go in through the ingest socket, time moves only by
// TestClock, and the test reads what viewers, the relay, the recorded day GETs
// and the index of days receive. Handing a second trading day the first's
// database is the object restarting after a deploy.

import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  ViewerProtocolVersion,
  WibDate,
  bookAt,
  decodeBookChunk,
  decodeDayStrip,
  decodeIngestDown,
  decodeRecordedCandles,
  decodeRecordedGaps,
  decodeRecordedTape,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type RecordedDay,
  type RecordedResource,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Exit, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import { makeDayIndex } from "@/server/market-live/day-index"
import { makeDayStore, type Sql } from "@/server/market-live/day-store"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import recorded from "./fixtures/ajaib-trades-2026-11-09.json"
import { retainedHeap } from "../../support/retained-heap.ts"
import { FULL_DAY_CODES, FULL_DAY_MINUTES } from "./full-day"
import { doubleField, messageField, stringField, varintField } from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  private codes: ReadonlyArray<StockCode> = []
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
  // The selected code first: whole books go out only for selected codes.
  watching = Effect.sync(() => this.codes)
  setWatching = (codes: ReadonlyArray<StockCode>) =>
    Effect.sync(() => {
      this.codes = codes
    })
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)

// An Ajaib TRADE frame shaped like the recorded ones.
const ajaibTrade = (trade: {
  readonly seq: number
  readonly time: string
  readonly ticker?: string
  readonly price?: number
  readonly lot?: number
}) =>
  JSON.stringify({
    ...JSON.parse(recorded.session1[0]!),
    ticker: trade.ticker ?? "BBCA",
    price: trade.price ?? 8_000,
    lot: trade.lot ?? 1,
    tradedAt: `2026-11-09T${trade.time}.000+07:00`,
    tradeNum: `20261109${String(trade.seq).padStart(10, "0")}`,
  })

// Ajaib's `ORDER_BOOK_CUSTOM` frame of BBCA's whole book, as of `time`, or
// of the levels that changed when `initial` is false.
const ajaibBookFrame = (
  time: string,
  buy: ReadonlyArray<readonly [price: number, lot: number, num: number]>,
  sell: ReadonlyArray<readonly [price: number, lot: number, num: number]>,
  initial = true
) =>
  JSON.stringify({
    ticker: "BBCA",
    ...(initial ? { is_initial: "true" } : {}),
    buy: buy.map(([price, lot, num]) => ({ price, lot, num })),
    sell: sell.map(([price, lot, num]) => ({ price, lot, num })),
    updateTime: wib(time).epochMilliseconds,
  })

// Stockbit's `order_book` frame (wrapper case 10): one full side, with its
// sequence number when given.
const orderBookFrame = (
  side: "BID" | "OFFER",
  levels: ReadonlyArray<readonly [price: number, orders: number, lots: number]>,
  time: string,
  sequence?: number
) => {
  const shares = levels.reduce((total, [, , lots]) => total + lots * 100, 0)
  const body = [
    "#O",
    "BBCA",
    side,
    ...levels.map(
      ([price, orders, lots]) => `${price};${orders};${lots * 100}`
    ),
    `0-${levels.length}&${shares}`,
  ].join("|")
  return Uint8Array.from(
    messageField(10, [
      ...stringField(1, "BBCA"),
      ...stringField(2, body),
      ...(sequence === undefined ? [] : varintField(3, sequence)),
      ...stringField(5, `2026-11-09T${time}+07:00`),
    ])
  )
}

// Stockbit's `liveprice` frame (wrapper case 9) of an index or a stock, on
// the regular board unless `board` says otherwise (2 is the cash board).
const livePriceFrame = (price: {
  readonly code: string
  readonly last: number
  // Absent, with the change, as an index's frames leave it.
  readonly previous?: number
  readonly time: string
  readonly isIndex?: boolean
  readonly board?: number
}) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, price.code),
      ...doubleField(2, price.last),
      ...doubleField(3, 1_000_000),
      ...doubleField(7, 100),
      ...stringField(11, `2026-11-09T${price.time}+07:00`),
      ...(price.previous === undefined ? [] : doubleField(13, price.previous)),
      ...doubleField(14, 5e9),
      ...(price.previous === undefined
        ? []
        : messageField(15, [
            ...doubleField(1, price.last - price.previous),
            ...doubleField(
              2,
              ((price.last - price.previous) / price.previous) * 100
            ),
          ])),
      ...(price.isIndex === true
        ? varintField(18, 1)
        : varintField(23, price.board ?? 1)),
    ])
  )

// A `liveprice` frame carrying only the day's totals: no last price, previous
// close or range.
const totalsFrame = (price: {
  readonly code: string
  readonly volume: number
  readonly time: string
}) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, price.code),
      ...doubleField(3, price.volume),
      ...doubleField(7, 100),
      ...stringField(11, `2026-11-09T${price.time}+07:00`),
      ...doubleField(14, 5e9),
      ...varintField(23, 1),
    ])
  )

const tradingDay = Effect.fnUntraced(function* (
  sql: Sql,
  recordDay?: (day: RecordedDay) => Effect.Effect<void, unknown>,
  // The ready ingest socket an object woken from hibernation still holds:
  // no token goes down it.
  held?: FakeSocket
) {
  const viewers: Array<FakeSocket> = []
  const relays: Array<FakeSocket> = []
  const alarms: Array<DateTime.Utc> = []
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql,
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
    ...(recordDay === undefined ? {} : { recordDay }),
  }).pipe(Scope.provide(scope))
  const ingest = (socket: FakeSocket, text: string) =>
    day.ingestMessage(socket, text).pipe(Effect.provide(env))
  const relay = held ?? new FakeSocket()
  relays.push(relay)
  if (held === undefined)
    yield* ingest(
      relay,
      yield* encodeIngestUp({
        _tag: "Token",
        protocolVersion: IngestProtocolVersion,
        token: TOKEN,
      })
    )
  const ajaib = Effect.fnUntraced(function* (frames: ReadonlyArray<string>) {
    yield* ingest(
      relay,
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        stream: "trade",
        connection: "A",
        receivedAt: yield* DateTime.now,
        frames,
      })
    )
  })
  const stockbit = Effect.fnUntraced(function* (
    frames: ReadonlyArray<Uint8Array>
  ) {
    yield* ingest(
      relay,
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt: yield* DateTime.now,
        frames,
      })
    )
  })
  // A page selecting `selected`: what it was sent so far.
  const viewer = Effect.fnUntraced(function* (selected = "BBCA") {
    const socket = new FakeSocket()
    viewers.push(socket)
    yield* day.viewerMessage(
      socket,
      yield* encodeViewerUp({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make(selected),
        watchlist: [],
      })
    )
    return Effect.suspend(() =>
      Effect.forEach(socket.sent, (text) => decodeViewerDown(text))
    )
  })
  const get = (resource: RecordedResource) => day.recorded(resource)
  // Everything the relay was sent down its ingest socket.
  const requests = Effect.suspend(() =>
    Effect.forEach(relay.sent, (text) => decodeIngestDown(text))
  )
  // The object goes away, its timers with it; its database stays.
  const stop = Scope.close(scope, Exit.void)
  // The Durable Object's alarm firing.
  const alarm = day.alarm.pipe(Effect.provide(env))
  // The relay's last ingest socket closing.
  const relayClosed = day.ingestClosed(relay)
  return {
    ajaib,
    stockbit,
    viewer,
    get,
    requests,
    alarms,
    alarm,
    stop,
    relayClosed,
    relay,
  }
})

const textOf = (response: Response) => Effect.promise(() => response.text())

const tapeAt = Effect.fnUntraced(function* (
  get: (resource: RecordedResource) => Effect.Effect<Response, unknown>,
  at: DateTime.Utc,
  before?: TradeNumber
) {
  const response = yield* get(
    before === undefined ? { _tag: "Tape", at } : { _tag: "Tape", at, before }
  )
  const { trades } = yield* decodeRecordedTape(yield* textOf(response))
  return { response, numbers: trades.map((trade) => trade.tradeNumber) }
})

const candlesOf = (messages: ReadonlyArray<ViewerDown>, code: string) =>
  messages.flatMap((message) =>
    message.candles
      .filter((candle) => candle.code === code)
      .map((candle) => ({
        minute: DateTime.formatIso(candle.minute),
        volume: candle.volume,
        frequency: candle.frequency,
      }))
  )

// What a flush needs: the merge window closed, then the minute's timer.
const pastFlush = TestClock.adjust("70 seconds")

// `sql` with its storage transactions failing, as a Durable Object's can:
// the ones whose ordinal (from 1) `failing` names throw, the rest commit.
const flakySql = (sql: Sql, failing: ReadonlyArray<number>): Sql => {
  let transactions = 0
  return {
    exec: sql.exec,
    transaction: (write) => {
      transactions += 1
      // The storage API is synchronous and throws; runSync throws the failure.
      if (failing.includes(transactions))
        return Effect.runSync(Effect.fail(new Error("Storage write failed")))
      sql.transaction(write)
    },
  }
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

// Decision: a restarted object may keep at most 32 MiB (33.6 MB) of a full
// day on the heap, about a quarter of the Durable Object's 128 MB memory
// limit (https://developers.cloudflare.com/durable-objects/platform/limits/,
// read 2026-11-10): the whole day's candles kept as objects take about
// 180 MiB (measured 2026-11-10).
const RESTART_HEAP_LIMIT = 32 * 2 ** 20

describe("a restarted trading day", () => {
  it.effect(
    "serves a full day's candles, every code's, keeping under 32 MiB of it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("16:20:00").epochMilliseconds)
        const sql = memorySql()
        const store = yield* makeDayStore(sql, { today: true })
        const first = DateTime.toEpochMillis(wib("08:58:00"))
        const codes = Array.from({ length: FULL_DAY_CODES }, (_, index) =>
          StockCode.make(`C${String(index).padStart(3, "0")}`)
        )
        yield* store.write({
          trades: [],
          footprints: [],
          livePrices: [],
          chunks: [],
          ajaibBooks: [],
          facts: {},
          candles: codes.flatMap((code) =>
            Array.from({ length: FULL_DAY_MINUTES }, (_, index) => ({
              code,
              minute: first + index * 60_000,
              figures: {
                openOrder: BigInt(index * 2),
                open: 100,
                closeOrder: BigInt(index * 2 + 1),
                close: 101,
                closeTime: first + index * 60_000 + 30_000,
                high: 102,
                low: 99,
                volume: 10,
                value: 101_000,
                buyValue: 0,
                sellValue: 0,
                frequency: 2,
              },
            }))
          ),
        })
        const before = yield* retainedHeap
        const restarted = yield* tradingDay(sql)
        const retained = (yield* retainedHeap) - before
        for (const code of [codes[0]!, codes.at(-1)!]) {
          const [snapshot] = yield* yield* restarted.viewer(code)
          assert.lengthOf(snapshot?.candles ?? [], FULL_DAY_MINUTES)
          assert.strictEqual(snapshot?.candles.at(-1)?.close, 101)
        }
        assert.isBelow(
          retained,
          RESTART_HEAP_LIMIT,
          `${(retained / 2 ** 20).toFixed(0)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "keeps its tape and candles, and a late copy of a stored trade counts nowhere twice",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:01").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        yield* first.ajaib(recorded.session1)
        yield* pastFlush
        const [before] = yield* yield* first.viewer()
        yield* first.stop

        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer()
        const [snapshot] = yield* page
        assert.deepStrictEqual(snapshot?.tape, before?.tape)
        assert.deepStrictEqual(snapshot?.candles, before?.candles)
        assert.lengthOf(snapshot?.tape ?? [], 60)

        // Connection B's copies of the same trades.
        yield* restarted.ajaib(recorded.session1)
        yield* TestClock.adjust("1 second")
        const deltas = (yield* page).slice(1)
        assert.deepStrictEqual(
          deltas.flatMap((delta) => delta.tape),
          []
        )
        assert.deepStrictEqual(candlesOf(deltas, "BBCA"), [])
      })
  )

  it.effect(
    "a flush whose write failed is written by the next, so a restart keeps its trades with their candles",
    () =>
      Effect.gen(function* () {
        // The first flush, at 09:01:05, takes the trades: their merge
        // windows closed.
        yield* TestClock.setTime(wib("09:00:10").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(flakySql(sql, [1]))
        yield* first.ajaib(
          range(1, 10).map((seq) => ajaibTrade({ seq, time: "09:00:30" }))
        )
        yield* pastFlush
        yield* first.ajaib(
          range(11, 20).map((seq) => ajaibTrade({ seq, time: "09:01:30" }))
        )
        yield* pastFlush
        yield* first.stop

        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* yield* restarted.viewer()
        assert.deepStrictEqual(
          snapshot?.tape.map((trade) => trade.tradeNumber),
          range(1, 20).map(String)
        )
        assert.deepStrictEqual(
          snapshot?.candles.map((candle) => candle.frequency),
          [10, 10]
        )
      })
  )

  it.effect("asks the relay for the numbers it missed while it was down", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("09:01:00").epochMilliseconds)
      const sql = memorySql()
      const first = yield* tradingDay(sql)
      yield* first.ajaib(
        range(1, 10).map((seq) => ajaibTrade({ seq, time: "09:00:30" }))
      )
      yield* pastFlush
      yield* first.stop

      const restarted = yield* tradingDay(sql)
      yield* restarted.ajaib([ajaibTrade({ seq: 20, time: "09:02:10" })])
      yield* TestClock.adjust("6 seconds")
      const asked = (yield* restarted.requests).flatMap((message) =>
        message._tag === "Backfill" ? [[message.from, message.to]] : []
      )
      assert.deepStrictEqual(asked, [["11", "19"]])
    })
  )

  it.effect(
    "keeps the morning's feed record: only its own downtime is a relay gap",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        // Both feeds every 10 s from 09:00:00 to 09:05:50.
        for (const seq of range(1, 36)) {
          const seconds = (seq - 1) * 10
          const time = `09:0${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
          yield* first.ajaib([ajaibTrade({ seq, time })])
          yield* first.stockbit([
            livePriceFrame({
              code: "BBCA",
              last: 8_000,
              previous: 7_975,
              time,
            }),
          ])
          yield* TestClock.adjust("10 seconds")
        }
        yield* first.stop
        yield* TestClock.setTime(wib("09:10:00").epochMilliseconds)

        const restarted = yield* tradingDay(sql)
        yield* TestClock.adjust("30 seconds")
        const [snapshot] = yield* yield* restarted.viewer()
        const gaps = (
          snapshot?._tag === "Snapshot" ? snapshot.conditions.gaps : []
        ).map((gap) => ({
          from: DateTime.formatIso(gap.from),
          to: gap.to === undefined ? undefined : DateTime.formatIso(gap.to),
        }))
        // The 08:58 match minute before the relay delivered, then from the
        // restart on; the six minutes the relay delivered are not a gap.
        assert.deepStrictEqual(gaps, [
          {
            from: "2026-11-09T01:58:00.000Z",
            to: "2026-11-09T01:59:00.000Z",
          },
          { from: "2026-11-09T02:10:00.000Z", to: undefined },
        ])
      })
  )

  it.effect(
    "keeps the relay gap from the instant the relay went offline, past a restart",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        // Ajaib live through the 09:01:05 flush, which stored it up; the
        // relay goes at 09:01:10, after it.
        for (let tick = 0; tick < 7; tick++) {
          const time = DateTime.formatIso(
            DateTime.add(wib("09:00:00"), { hours: 7, seconds: tick * 10 })
          ).slice(11, 19)
          yield* first.ajaib([ajaibTrade({ seq: tick + 1, time })])
          yield* TestClock.adjust("10 seconds")
        }
        yield* first.relayClosed
        yield* first.stop
        yield* TestClock.setTime(wib("10:00:00").epochMilliseconds)

        const restarted = yield* tradingDay(sql)
        yield* TestClock.adjust("1 second")
        const [snapshot] = yield* yield* restarted.viewer()
        const gaps = (
          snapshot?._tag === "Snapshot" ? snapshot.conditions.gaps : []
        ).map((gap) => ({
          from: DateTime.formatIso(gap.from),
          to: gap.to === undefined ? undefined : DateTime.formatIso(gap.to),
        }))
        assert.deepStrictEqual(gaps, [
          {
            from: "2026-11-09T01:58:00.000Z",
            to: "2026-11-09T01:59:00.000Z",
          },
          { from: "2026-11-09T02:01:10.000Z", to: undefined },
        ])
      })
  )

  it.effect(
    "keeps the relay gap from the wake when the relay's close is the first event after hibernation",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        // Ajaib live through the 09:01:05 flush, which stored it up.
        for (let tick = 0; tick < 7; tick++) {
          const time = DateTime.formatIso(
            DateTime.add(wib("09:00:00"), { hours: 7, seconds: tick * 10 })
          ).slice(11, 19)
          yield* first.ajaib([ajaibTrade({ seq: tick + 1, time })])
          yield* TestClock.adjust("10 seconds")
        }
        // The object hibernates: its instance and timers go, its socket and
        // store stay. The relay's close at 09:30 wakes a fresh instance,
        // whose first event it is; the object is then evicted.
        yield* first.stop
        yield* TestClock.setTime(wib("09:30:00").epochMilliseconds)
        const woken = yield* tradingDay(sql, undefined, first.relay)
        yield* woken.relayClosed
        yield* woken.stop
        yield* TestClock.setTime(wib("10:00:00").epochMilliseconds)

        const restarted = yield* tradingDay(sql)
        yield* TestClock.adjust("1 second")
        const [snapshot] = yield* yield* restarted.viewer()
        const gaps = (
          snapshot?._tag === "Snapshot" ? snapshot.conditions.gaps : []
        ).map((gap) => ({
          from: DateTime.formatIso(gap.from),
          to: gap.to === undefined ? undefined : DateTime.formatIso(gap.to),
        }))
        assert.deepStrictEqual(gaps, [
          {
            from: "2026-11-09T01:58:00.000Z",
            to: "2026-11-09T01:59:00.000Z",
          },
          { from: "2026-11-09T02:30:00.000Z", to: undefined },
        ])
      })
  )

  it.effect(
    "rebuilds its last-frame cache: the order book and Day state from the store",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:30:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        // A viewer on BBCA, so the day records its book.
        yield* first.viewer()
        yield* first.stockbit([
          livePriceFrame({
            code: "BBCA",
            last: 8_000,
            previous: 7_975,
            time: "09:30:00",
          }),
          orderBookFrame("BID", [[8_000, 3, 50]], "09:30:00"),
          orderBookFrame("OFFER", [[8_025, 2, 40]], "09:30:00"),
        ])
        yield* pastFlush
        const [before] = yield* yield* first.viewer()
        yield* first.stop

        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* yield* restarted.viewer()
        const bookOf = (message: ViewerDown | undefined) =>
          message?._tag === "Snapshot" ? message.orderBook : undefined
        assert.isDefined(bookOf(before))
        assert.deepStrictEqual(bookOf(snapshot), bookOf(before))
        assert.deepStrictEqual(snapshot?.dayStates, before?.dayStates)
        assert.strictEqual(snapshot?.dayStates?.[0]?.last, 8_000)
      })
  )

  it.effect(
    "keeps an Ajaib book's levels past the 20 served, and its totals, for the deltas after",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        // 25 levels a side of 10 lots each; the object serves 20.
        const levels = (from: number, step: number) =>
          range(0, 24).map((index) => [from + index * step, 10, 1] as const)
        yield* first.ajaib([
          ajaibBookFrame("09:00:00", levels(8_000, -5), levels(8_025, 5)),
        ])
        yield* pastFlush
        yield* first.stop

        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("BBCA")
        const [snapshot] = yield* page
        const bookOf = (message: ViewerDown | undefined) => {
          const book =
            message?._tag === "Snapshot"
              ? message.orderBook
              : message?.orderBooks?.find((held) => held.code === "BBCA")
          return book?._tag === "OrderBook"
            ? { bids: book.bids.length, bidLots: book.bidLots }
            : undefined
        }
        assert.deepStrictEqual(bookOf(snapshot), { bids: 20, bidLots: 250 })
        // The 25th bid, below the served ones, is taken away.
        yield* restarted.ajaib([
          ajaibBookFrame("09:01:30", [[8_000 - 24 * 5, 0, 0]], [], false),
        ])
        yield* TestClock.adjust("1 second")
        const delta = (yield* page).at(-1)
        assert.deepStrictEqual(bookOf(delta), { bids: 20, bidLots: 240 })
      })
  )

  it.effect(
    "keeps the readings of a book last served in a session, for the break's snapshots",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("11:29:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        yield* first.ajaib([
          ajaibBookFrame("11:29:00", [[8_000, 30, 3]], [[8_025, 10, 1]]),
        ])
        yield* pastFlush
        yield* first.stop

        yield* TestClock.setTime(wib("12:10:00").epochMilliseconds)
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("TLKM")
        const [snapshot] = yield* page
        assert(snapshot?._tag === "Snapshot")
        assert.deepStrictEqual(
          (snapshot.bookReadings ?? []).map((reading) => ({
            code: reading.code,
            imbalance: reading.imbalance,
          })),
          [{ code: StockCode.make("BBCA"), imbalance: 0.5 }]
        )
      })
  )

  it.effect(
    "keeps a code's last price and previous close past a totals-only liveprice frame",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.stockbit([
          livePriceFrame({
            code: "BBCA",
            last: 9_000,
            previous: 8_900,
            time: "09:00:00",
          }),
        ])
        yield* day.stockbit([
          totalsFrame({ code: "BBCA", volume: 2_000_000, time: "09:00:30" }),
        ])
        yield* pastFlush
        yield* day.stop
        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* yield* restarted.viewer("BBCA")
        const state = snapshot?.dayStates?.find(
          (dayState) => dayState.code === "BBCA"
        )
        assert.deepStrictEqual(
          {
            last: state?.last,
            previousClose: state?.previousClose,
            volume: state?.volume,
          },
          { last: 9_000, previousClose: 8_900, volume: 20_000 }
        )
      })
  )

  it.effect(
    "keeps a code's regular-board figures past a newer cash-board liveprice frame",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:00").epochMilliseconds)
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.stockbit([
          livePriceFrame({
            code: "BBCA",
            last: 9_000,
            previous: 8_900,
            time: "09:00:00",
          }),
          livePriceFrame({
            code: "BBCA",
            last: 9_100,
            previous: 8_900,
            time: "09:00:30",
            board: 2,
          }),
        ])
        yield* pastFlush
        yield* day.stop
        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* yield* restarted.viewer("BBCA")
        const state = snapshot?.dayStates?.find(
          (dayState) => dayState.code === "BBCA"
        )
        assert.deepStrictEqual(
          { last: state?.last, provenance: state?.provenance },
          { last: 9_000, provenance: "Ajaib" }
        )
      })
  )

  it.effect(
    "carries a code's Day state on from the stored trades after its last liveprice frame",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:30:00").epochMilliseconds)
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.stockbit([
          livePriceFrame({
            code: "BBCA",
            last: 8_000,
            previous: 7_975,
            time: "09:30:00",
          }),
        ])
        // One in the frame's minute, one in the next.
        yield* day.ajaib([
          ajaibTrade({ seq: 1, time: "09:30:20", price: 8_025, lot: 3 }),
          ajaibTrade({ seq: 2, time: "09:31:10", price: 8_050, lot: 2 }),
        ])
        yield* pastFlush
        yield* day.stop
        // Stockbit is lost from the restart until its next frame.
        const restarted = yield* tradingDay(sql)
        const [snapshot] = yield* yield* restarted.viewer("BBCA")
        const state = snapshot?.dayStates?.find(
          (dayState) => dayState.code === "BBCA"
        )
        assert.deepStrictEqual(
          state === undefined
            ? undefined
            : {
                ...state,
                code: String(state.code),
                asOf: DateTime.formatIso(state.asOf),
              },
          {
            code: "BBCA",
            last: 8_050,
            previousClose: 7_975,
            change: { amount: 75, percent: (75 / 7_975) * 100 },
            open: 8_000,
            high: 8_050,
            low: 8_000,
            volume: 10_000 + 5,
            value: 5e9 + 8_025 * 300 + 8_050 * 200,
            frequency: 100 + 2,
            asOf: "2026-11-09T02:31:10.000Z",
            provenance: "Ajaib",
          }
        )
      })
  )
})

describe("a trade older than the tape", () => {
  it.effect(
    "that a failed flush took still counts once when its copy comes after the tape evicted it",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:00:10").epochMilliseconds)
        const day = yield* tradingDay(flakySql(memorySql(), [1]))
        const page = yield* day.viewer("UNVR")
        const early = ajaibTrade({
          seq: 50,
          time: "09:00:30",
          ticker: "UNVR",
          lot: 7,
        })
        yield* day.ajaib([early])
        // The 09:01:05 flush takes it, and its write fails.
        yield* pastFlush
        // A full tape of newer trades evicts it, then its copy comes.
        yield* day.ajaib(
          range(100_001, 110_000).map((seq) =>
            ajaibTrade({ seq, time: "09:01:10", ticker: "TLKM" })
          )
        )
        yield* day.ajaib([early])
        yield* TestClock.adjust("1 second")
        const deltas = (yield* page).slice(1)
        assert.deepStrictEqual(candlesOf(deltas, "UNVR"), [
          { minute: "2026-11-09T02:00:00.000Z", volume: 7, frequency: 1 },
        ])
      })
  )

  it.effect("still lands in its own minute's candle, once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("09:10:00").epochMilliseconds)
      const sql = memorySql()
      const day = yield* tradingDay(sql)
      const page = yield* day.viewer("UNVR")
      // A full tape of newer trades.
      yield* day.ajaib(
        range(100_001, 110_000).map((seq) =>
          ajaibTrade({ seq, time: "09:05:00", ticker: "TLKM" })
        )
      )
      const late = ajaibTrade({
        seq: 50,
        time: "09:00:30",
        ticker: "UNVR",
        lot: 7,
      })
      yield* day.ajaib([late])
      yield* TestClock.adjust("1 second")
      const deltas = (yield* page).slice(1)
      assert.deepStrictEqual(candlesOf(deltas, "UNVR"), [
        { minute: "2026-11-09T02:00:00.000Z", volume: 7, frequency: 1 },
      ])
      assert.isFalse(
        deltas.some((delta) =>
          delta.tape.some((trade) => trade.tradeNumber === "50")
        )
      )

      // Again after it was stored, and after a restart.
      yield* pastFlush
      yield* day.ajaib([late])
      yield* day.stop
      const restarted = yield* tradingDay(sql)
      const later = yield* restarted.viewer("UNVR")
      yield* restarted.ajaib([late])
      yield* TestClock.adjust("1 second")
      const [snapshot, ...rest] = yield* later
      assert.deepStrictEqual(candlesOf([snapshot!], "UNVR"), [
        { minute: "2026-11-09T02:00:00.000Z", volume: 7, frequency: 1 },
      ])
      assert.deepStrictEqual(candlesOf(rest, "UNVR"), [])
    })
  )
})

describe("the recorded tape", () => {
  it.effect("answers the 200 newest trades at or before T", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("09:06:00").epochMilliseconds)
      const day = yield* tradingDay(memorySql())
      // Trade n at 09:00:00 + n seconds, sent newest first.
      yield* day.ajaib(
        range(1, 300)
          .reverse()
          .map((seq) =>
            ajaibTrade({
              seq,
              time: `09:${String(Math.floor(seq / 60)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}`,
            })
          )
      )
      yield* pastFlush

      const { response, numbers } = yield* tapeAt(day.get, wib("09:04:00"))
      assert.lengthOf(numbers, 200)
      assert.strictEqual(numbers[0], "41")
      assert.strictEqual(numbers.at(-1), "240")
      // Not sealed yet: not cached.
      assert.strictEqual(response.headers.get("Cache-Control"), "no-store")

      assert.deepStrictEqual(
        (yield* tapeAt(day.get, wib("09:00:05.500"))).numbers,
        ["1", "2", "3", "4", "5"]
      )
      assert.deepStrictEqual(
        (yield* tapeAt(day.get, wib("08:59:00"))).numbers,
        []
      )
    })
  )

  it.effect(
    "walks back inside one instant past its newest 200, below each page's oldest trade",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:06:00").epochMilliseconds)
        const day = yield* tradingDay(memorySql())
        // 1..5 at 09:00:00, 6..455 all at 09:00:01, 456..460 at 09:00:02.
        const timeOf = (seq: number) =>
          seq <= 5 ? "09:00:00" : seq <= 455 ? "09:00:01" : "09:00:02"
        yield* day.ajaib(
          range(1, 460).map((seq) => ajaibTrade({ seq, time: timeOf(seq) }))
        )
        yield* pastFlush

        const at = wib("09:00:01")
        const pages: Array<ReadonlyArray<string>> = []
        let before: TradeNumber | undefined
        // Bounded, so a cursor the store ignores fails rather than spins.
        for (let page = 0; page < 5; page++) {
          const { numbers } = yield* tapeAt(day.get, at, before)
          if (numbers.length === 0) break
          pages.push(numbers)
          before = TradeNumber.make(numbers[0]!)
        }

        assert.deepStrictEqual(
          pages.map((page) => [page[0], page.at(-1), page.length]),
          [
            ["256", "455", 200],
            ["56", "255", 200],
            ["1", "55", 55],
          ]
        )
        assert.deepStrictEqual(
          [...pages].reverse().flat(),
          range(1, 455).map(String)
        )
      })
  )
})

describe("the recorded order book", () => {
  it.effect("replays a minute's chunk to the frame in force at a cursor", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("14:20:10").epochMilliseconds)
      const day = yield* tradingDay(memorySql())
      // A viewer on BBCA, so the day records its book.
      yield* day.viewer()
      yield* day.stockbit([
        orderBookFrame("BID", [[8_000, 3, 50]], "14:20:10"),
        orderBookFrame("OFFER", [[8_025, 2, 40]], "14:20:10"),
      ])
      yield* TestClock.setTime(wib("14:20:40").epochMilliseconds)
      yield* day.stockbit([orderBookFrame("BID", [[8_000, 5, 90]], "14:20:40")])
      yield* TestClock.setTime(wib("14:21:30").epochMilliseconds)
      yield* day.stockbit([
        orderBookFrame("OFFER", [[8_050, 1, 10]], "14:21:30"),
      ])
      yield* TestClock.setTime(wib("14:23:00").epochMilliseconds)
      yield* day.stockbit([
        orderBookFrame("OFFER", [[8_050, 1, 12]], "14:23:00"),
      ])
      yield* TestClock.adjust("2 minutes")

      const chunkAt = Effect.fnUntraced(function* (minute: string) {
        const response = yield* day.get({
          _tag: "Book",
          code: StockCode.make("BBCA"),
          minute: wib(minute),
        })
        return yield* decodeBookChunk(yield* textOf(response))
      })
      const levels = Effect.fnUntraced(function* (
        minute: string,
        cursor: string
      ) {
        const book = yield* bookAt(yield* chunkAt(minute), wib(cursor))
        return book === undefined
          ? undefined
          : {
              bids: book.bids.map((level) => level.lots),
              offers: book.offers.map((level) => level.lots),
            }
      })

      const first = yield* chunkAt("14:20:00")
      assert.strictEqual(
        DateTime.formatIso(first.minute),
        "2026-11-09T07:20:00.000Z"
      )
      assert.isUndefined(yield* levels("14:20:00", "14:20:05"))
      assert.deepStrictEqual(yield* levels("14:20:00", "14:20:20"), {
        bids: [50],
        offers: [40],
      })
      assert.deepStrictEqual(yield* levels("14:20:00", "14:20:59"), {
        bids: [90],
        offers: [40],
      })
      // The next minute's chunk starts from the book in force when it began.
      assert.deepStrictEqual(yield* levels("14:21:00", "14:21:10"), {
        bids: [90],
        offers: [40],
      })
      assert.deepStrictEqual(yield* levels("14:21:00", "14:21:45"), {
        bids: [90],
        offers: [10],
      })
      // A minute with no frame answers the chunk before it: the book in force.
      assert.deepStrictEqual(yield* levels("14:22:00", "14:22:30"), {
        bids: [90],
        offers: [10],
      })
    })
  )

  it.effect(
    "replays a switch to Ajaib's older book when it was served, not at its as-of",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("14:20:10").epochMilliseconds)
        const day = yield* tradingDay(memorySql())
        yield* day.ajaib([
          ajaibBookFrame("14:20:05", [[8_000, 50, 3]], [[8_025, 40, 2]]),
        ])
        yield* day.stockbit([
          orderBookFrame("BID", [[8_000, 5, 90]], "14:20:10", 100),
          orderBookFrame("OFFER", [[8_025, 1, 10]], "14:20:10", 101),
        ])
        yield* day.viewer()
        // 15 s without a Stockbit frame: stale, so Ajaib's book is served.
        yield* TestClock.adjust("16 seconds")
        yield* TestClock.adjust("2 minutes")
        const response = yield* day.get({
          _tag: "Book",
          code: StockCode.make("BBCA"),
          minute: wib("14:20:00"),
        })
        const chunk = yield* decodeBookChunk(yield* textOf(response))
        const served = Effect.fnUntraced(function* (cursor: string) {
          const book = yield* bookAt(chunk, wib(cursor))
          return book === undefined
            ? undefined
            : {
                provenance: book.provenance,
                at: DateTime.formatIso(book.at),
                bidAt: book.bidAt && DateTime.formatIso(book.bidAt),
                offerAt: book.offerAt && DateTime.formatIso(book.offerAt),
                bidSequence: book.bidSequence,
                offerSequence: book.offerSequence,
              }
        })
        assert.deepStrictEqual(yield* served("14:20:15"), {
          provenance: "Stockbit",
          at: "2026-11-09T07:20:10.000Z",
          bidAt: "2026-11-09T07:20:10.000Z",
          offerAt: "2026-11-09T07:20:10.000Z",
          bidSequence: 100,
          offerSequence: 101,
        })
        // Ajaib's book has no sequence numbers: Stockbit's don't carry over.
        assert.deepStrictEqual(yield* served("14:20:40"), {
          provenance: "Ajaib",
          at: "2026-11-09T07:20:05.000Z",
          bidAt: "2026-11-09T07:20:05.000Z",
          offerAt: "2026-11-09T07:20:05.000Z",
          bidSequence: undefined,
          offerSequence: undefined,
        })
      })
  )

  it.effect(
    "keeps each side's own time and sequence number, so a minute's frames order per side",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("14:20:12").epochMilliseconds)
        const day = yield* tradingDay(memorySql())
        yield* day.stockbit([
          orderBookFrame("BID", [[8_000, 3, 50]], "14:20:10", 10_320),
          orderBookFrame("OFFER", [[8_025, 2, 40]], "14:20:12", 10_318),
        ])
        yield* TestClock.setTime(wib("14:20:40").epochMilliseconds)
        yield* day.stockbit([
          orderBookFrame("BID", [[8_000, 5, 90]], "14:20:40", 10_377),
        ])
        yield* TestClock.setTime(wib("14:21:30").epochMilliseconds)
        yield* day.stockbit([
          orderBookFrame("OFFER", [[8_050, 1, 10]], "14:21:30", 10_402),
        ])
        yield* TestClock.adjust("2 minutes")

        const sides = Effect.fnUntraced(function* (
          minute: string,
          cursor: string
        ) {
          const response = yield* day.get({
            _tag: "Book",
            code: StockCode.make("BBCA"),
            minute: wib(minute),
          })
          const chunk = yield* decodeBookChunk(yield* textOf(response))
          const book = yield* bookAt(chunk, wib(cursor))
          return book === undefined
            ? undefined
            : {
                bidAt: book.bidAt && DateTime.formatIso(book.bidAt),
                offerAt: book.offerAt && DateTime.formatIso(book.offerAt),
                bidSequence: book.bidSequence,
                offerSequence: book.offerSequence,
              }
        })

        assert.deepStrictEqual(yield* sides("14:20:00", "14:20:20"), {
          bidAt: "2026-11-09T07:20:10.000Z",
          offerAt: "2026-11-09T07:20:12.000Z",
          bidSequence: 10_320,
          offerSequence: 10_318,
        })
        assert.deepStrictEqual(yield* sides("14:20:00", "14:20:50"), {
          bidAt: "2026-11-09T07:20:40.000Z",
          offerAt: "2026-11-09T07:20:12.000Z",
          bidSequence: 10_377,
          offerSequence: 10_318,
        })
        // The next minute's chunk starts from the book in force, sides and all.
        assert.deepStrictEqual(yield* sides("14:21:00", "14:21:10"), {
          bidAt: "2026-11-09T07:20:40.000Z",
          offerAt: "2026-11-09T07:20:12.000Z",
          bidSequence: 10_377,
          offerSequence: 10_318,
        })
        assert.deepStrictEqual(yield* sides("14:21:00", "14:21:45"), {
          bidAt: "2026-11-09T07:20:40.000Z",
          offerAt: "2026-11-09T07:21:30.000Z",
          bidSequence: 10_377,
          offerSequence: 10_402,
        })
      })
  )

  it.effect(
    "a chunk stored before the per-side times decodes and replays as before",
    () =>
      Effect.gen(function* () {
        const ms = (time: string) => wib(time).epochMilliseconds
        // As the object stored it before bidAt, offerAt and the sequences.
        const stored = JSON.stringify({
          code: "BBCA",
          minute: ms("14:20:00"),
          start: {
            _tag: "OrderBook",
            code: "BBCA",
            bids: [{ price: 8_000, lots: 50, orders: 3 }],
            offers: [{ price: 8_025, lots: 40, orders: 2 }],
            bidLots: 50,
            offerLots: 40,
            at: ms("14:19:50"),
            provenance: "Stockbit",
            previousClose: 8_000,
          },
          deltas: [
            {
              servedAt: ms("14:20:10"),
              at: ms("14:20:10"),
              bids: [{ price: 8_000, lots: 90, orders: 5 }],
              bidLots: 90,
            },
            {
              servedAt: ms("14:20:30"),
              at: ms("14:20:05"),
              provenance: "Ajaib",
              offers: [{ price: 8_050, lots: 10, orders: 1 }],
              offerLots: 10,
            },
          ],
        })
        const chunk = yield* decodeBookChunk(stored)
        const replayed = Effect.fnUntraced(function* (cursor: string) {
          const book = yield* bookAt(chunk, wib(cursor))
          return book === undefined
            ? undefined
            : { ...book, at: DateTime.toEpochMillis(book.at) }
        })
        assert.deepStrictEqual(yield* replayed("14:20:20"), {
          _tag: "OrderBook",
          code: StockCode.make("BBCA"),
          bids: [{ price: 8_000, lots: 90, orders: 5 }],
          offers: [{ price: 8_025, lots: 40, orders: 2 }],
          bidLots: 90,
          offerLots: 40,
          at: ms("14:20:10"),
          provenance: "Stockbit",
          previousClose: 8_000,
        })
        assert.deepStrictEqual(yield* replayed("14:20:40"), {
          _tag: "OrderBook",
          code: StockCode.make("BBCA"),
          bids: [{ price: 8_000, lots: 90, orders: 5 }],
          offers: [{ price: 8_050, lots: 10, orders: 1 }],
          bidLots: 90,
          offerLots: 10,
          at: ms("14:20:05"),
          provenance: "Ajaib",
          previousClose: 8_000,
        })
      })
  )
})

describe("the seal", () => {
  it.effect(
    "at 17:00 WIB writes the index row, stops ingest and makes the answers immutable",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("15:59:00").epochMilliseconds)
        const index = yield* makeDayIndex(memorySql())
        const day = yield* tradingDay(memorySql(), index.record)
        assert.deepStrictEqual(day.alarms.map(DateTime.formatIso), [
          "2026-11-09T10:00:00.000Z",
        ])
        yield* day.stockbit([
          livePriceFrame({
            code: "IHSG",
            last: 7_100,
            previous: 7_000,
            time: "15:59:00",
            isIndex: true,
          }),
        ])
        yield* day.ajaib(
          range(1, 30).map((seq) =>
            ajaibTrade({ seq, time: "15:59:00", ticker: "BBCA", lot: 2 })
          )
        )

        // An early alarm only sets itself again.
        yield* TestClock.setTime(wib("16:30:00").epochMilliseconds)
        yield* day.alarm
        assert.lengthOf(day.alarms, 2)
        assert.strictEqual(
          (yield* index.strip).status === 200 &&
            (yield* decodeDayStrip(yield* textOf(yield* index.strip))).days
              .length,
          0
        )

        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        const strip = yield* index.strip
        const { days } = yield* decodeDayStrip(yield* textOf(strip))
        assert.deepStrictEqual(days, [
          {
            day: DAY,
            ihsg: { close: 7_100, change: 100, changePercent: 100 / 70 },
            trades: 30,
            gap: true,
          },
        ])
        // Cached until 17:01 WIB, when the next seal could land.
        assert.strictEqual(
          strip.headers.get("Cache-Control"),
          "private, max-age=60"
        )

        // A late print is not taken.
        yield* day.ajaib([ajaibTrade({ seq: 31, time: "16:59:00" })])
        yield* pastFlush
        const { response, numbers } = yield* tapeAt(day.get, wib("17:00:00"))
        assert.lengthOf(numbers, 30)
        assert.strictEqual(
          response.headers.get("Cache-Control"),
          "private, max-age=31536000, immutable"
        )

        const candles = yield* decodeRecordedCandles(
          yield* textOf(
            yield* day.get({ _tag: "Candles", code: StockCode.make("IHSG") })
          )
        )
        assert.strictEqual(candles.previousClose, 7_000)
        assert.lengthOf(candles.candles, 1)
        const bbca = yield* decodeRecordedCandles(
          yield* textOf(
            yield* day.get({ _tag: "Candles", code: StockCode.make("BBCA") })
          )
        )
        assert.deepStrictEqual(
          bbca.candles.map((candle) => [candle.volume, candle.frequency]),
          [[60, 30]]
        )

        const gapsResponse = yield* day.get({ _tag: "Gaps" })
        const { gaps } = yield* decodeRecordedGaps(yield* textOf(gapsResponse))
        assert.isAbove(gaps.length, 0)
        assert.strictEqual(
          gapsResponse.headers.get("Cache-Control"),
          "private, max-age=31536000, immutable"
        )
      })
  )

  it.effect(
    "records IHSG's change as zero after a frame whose last price returned to the previous close",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("15:59:00").epochMilliseconds)
        const index = yield* makeDayIndex(memorySql())
        const day = yield* tradingDay(memorySql(), index.record)
        yield* day.stockbit([
          livePriceFrame({
            code: "IHSG",
            last: 7_100,
            previous: 7_000,
            time: "15:59:00",
            isIndex: true,
          }),
        ])
        // Back at the previous close: Stockbit leaves the zero change out.
        yield* day.stockbit([
          Uint8Array.from(
            messageField(9, [
              ...stringField(1, "IHSG"),
              ...doubleField(2, 7_000),
              ...doubleField(3, 1_000_000),
              ...doubleField(7, 100),
              ...stringField(11, "2026-11-09T15:59:30+07:00"),
              ...doubleField(13, 7_000),
              ...doubleField(14, 5e9),
              ...varintField(18, 1),
            ])
          ),
        ])
        yield* day.ajaib([ajaibTrade({ seq: 1, time: "15:59:00" })])
        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        const { days } = yield* decodeDayStrip(
          yield* textOf(yield* index.strip)
        )
        assert.deepStrictEqual(
          days.map((row) => row.ihsg),
          [{ close: 7_000, change: 0, changePercent: 0 }]
        )
      })
  )

  it.effect(
    "records no IHSG change when its frames carried no previous close, rather than a change from a price seen today",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("15:59:00").epochMilliseconds)
        const index = yield* makeDayIndex(memorySql())
        const day = yield* tradingDay(memorySql(), index.record)
        yield* day.stockbit([
          livePriceFrame({
            code: "IHSG",
            last: 7_000,
            time: "15:59:00",
            isIndex: true,
          }),
          livePriceFrame({
            code: "IHSG",
            last: 7_100,
            time: "15:59:30",
            isIndex: true,
          }),
        ])
        yield* day.ajaib([ajaibTrade({ seq: 1, time: "15:59:00" })])
        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        const { days } = yield* decodeDayStrip(
          yield* textOf(yield* index.strip)
        )
        assert.deepStrictEqual(
          days.map((row) => [row.trades, row.ihsg]),
          [[1, undefined]]
        )
      })
  )

  it.effect(
    "a seal whose final flush or sealed marker didn't land is retried a minute later",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("16:58:00").epochMilliseconds)
        const index = yield* makeDayIndex(memorySql())
        const sql = memorySql()
        // The minute's flush at 16:58:05 is the first transaction. The seal's
        // final flush is the second; the fourth, after the retry's flush, is
        // its sealed marker.
        const day = yield* tradingDay(flakySql(sql, [2, 4]), index.record)
        yield* day.ajaib(
          range(1, 10).map((seq) =>
            ajaibTrade({ seq, time: "16:58:00", ticker: "BBCA" })
          )
        )
        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        yield* TestClock.setTime(wib("17:01:00").epochMilliseconds)
        yield* day.alarm
        yield* TestClock.setTime(wib("17:02:00").epochMilliseconds)
        yield* day.alarm
        assert.deepStrictEqual(day.alarms.map(DateTime.formatIso), [
          "2026-11-09T10:00:00.000Z",
          "2026-11-09T10:01:00.000Z",
          "2026-11-09T10:02:00.000Z",
        ])
        const { days } = yield* decodeDayStrip(
          yield* textOf(yield* index.strip)
        )
        assert.deepStrictEqual(
          days.map((row) => [row.day, row.trades]),
          [[DAY, 10]]
        )
        // Sealed: a late print is not taken, and the answers are immutable.
        yield* day.ajaib([ajaibTrade({ seq: 11, time: "16:59:30" })])
        yield* pastFlush
        const { response, numbers } = yield* tapeAt(day.get, wib("17:02:00"))
        assert.deepStrictEqual(numbers, range(1, 10).map(String))
        assert.strictEqual(
          response.headers.get("Cache-Control"),
          "private, max-age=31536000, immutable"
        )
        const bbca = yield* decodeRecordedCandles(
          yield* textOf(
            yield* day.get({ _tag: "Candles", code: StockCode.make("BBCA") })
          )
        )
        assert.deepStrictEqual(
          bbca.candles.map((candle) => candle.frequency),
          [10]
        )
      })
  )

  it.effect("a sealed day stays sealed after a restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
      const sql = memorySql()
      const day = yield* tradingDay(sql)
      yield* day.ajaib([ajaibTrade({ seq: 1, time: "15:00:00" })])
      yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
      yield* day.alarm
      yield* day.stop
      yield* TestClock.adjust("1 day")

      const restarted = yield* tradingDay(sql)
      assert.lengthOf(restarted.alarms, 0)
      const { response, numbers } = yield* tapeAt(
        restarted.get,
        wib("17:00:00")
      )
      assert.deepStrictEqual(numbers, ["1"])
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "private, max-age=31536000, immutable"
      )
    })
  )
})
