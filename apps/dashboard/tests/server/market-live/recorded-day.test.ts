// Seam (a) of spec apinrdw/kumora#138, for storage, the seal and recorded day
// loads: envelopes go in through the ingest socket, time moves only by
// TestClock, and the test reads what viewers, the relay, the recorded day GETs
// and the index of days receive. Handing a second trading day the first's
// database is the object restarting after a deploy.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
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
import { doubleField, messageField, stringField, varintField } from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
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

// Stockbit's `order_book` frame (wrapper case 10): one full side.
const orderBookFrame = (
  side: "BID" | "OFFER",
  levels: ReadonlyArray<readonly [price: number, orders: number, lots: number]>,
  time: string
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
      ...stringField(5, `2026-11-09T${time}+07:00`),
    ])
  )
}

// Stockbit's `liveprice` frame (wrapper case 9) of an index or a stock, on
// the regular board unless `board` says otherwise (2 is the cash board).
const livePriceFrame = (price: {
  readonly code: string
  readonly last: number
  readonly previous: number
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
      ...doubleField(13, price.previous),
      ...doubleField(14, 5e9),
      ...messageField(15, [
        ...doubleField(1, price.last - price.previous),
        ...doubleField(
          2,
          ((price.last - price.previous) / price.previous) * 100
        ),
      ]),
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
  recordDay?: (day: RecordedDay) => Effect.Effect<void, unknown>
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
  const relay = new FakeSocket()
  relays.push(relay)
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
  return { ajaib, stockbit, viewer, get, requests, alarms, alarm, stop }
})

const textOf = (response: Response) => Effect.promise(() => response.text())

const tapeAt = Effect.fnUntraced(function* (
  get: (resource: RecordedResource) => Effect.Effect<Response, unknown>,
  at: DateTime.Utc
) {
  const response = yield* get({ _tag: "Tape", at })
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

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

// Decision: a full day for the restart's bound is 900 codes trading every
// minute from the 08:58 match to post-trading's end, about 400,000 candles:
// more codes than trade on a busy day, each in every minute.
const FULL_DAY_CODES = 900
const FULL_DAY_MINUTES = 438

describe("a restarted trading day", () => {
  it.effect(
    "restores a full day's candles, every code's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("16:20:00").epochMilliseconds)
        const sql = memorySql()
        const store = yield* makeDayStore(sql)
        const first = DateTime.toEpochMillis(wib("08:58:00"))
        const codes = Array.from({ length: FULL_DAY_CODES }, (_, index) =>
          StockCode.make(`C${String(index).padStart(3, "0")}`)
        )
        yield* store.write({
          trades: [],
          livePrices: [],
          chunks: [],
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
                high: 102,
                low: 99,
                volume: 10,
                value: 101_000,
                frequency: 2,
              },
            }))
          ),
        })
        const restarted = yield* tradingDay(sql)
        for (const code of [codes[0]!, codes.at(-1)!]) {
          const [snapshot] = yield* yield* restarted.viewer(code)
          assert.lengthOf(snapshot?.candles ?? [], FULL_DAY_MINUTES)
          assert.strictEqual(snapshot?.candles.at(-1)?.close, 101)
        }
      }),
    { timeout: 60_000 }
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
    "rebuilds its last-frame cache: the order book and Day state from the store",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("09:30:00").epochMilliseconds)
        const sql = memorySql()
        const first = yield* tradingDay(sql)
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
            : { ...state, asOf: DateTime.formatIso(state.asOf) },
          {
            code: "BBCA",
            last: 8_050,
            previousClose: 7_975,
            change: 75,
            changePercent: (75 / 7_975) * 100,
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
})

describe("the recorded order book", () => {
  it.effect("replays a minute's chunk to the frame in force at a cursor", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("14:20:10").epochMilliseconds)
      const day = yield* tradingDay(memorySql())
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
