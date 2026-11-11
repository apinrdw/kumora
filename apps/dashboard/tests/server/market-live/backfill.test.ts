// Seam (a) of spec apinrdw/kumora#138, for backfill: a trade number the merged
// tape misses is asked for down the ingest socket, and the REST pages the
// relay sends back fill it. Recorded Ajaib frames go in, time moves only by
// TestClock, and the test reads what the relay and the viewers receive.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  ViewerProtocolVersion,
  WibDate,
  decodeIngestDown,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type Feed,
  type IngestDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import recorded from "./fixtures/ajaib-trades-2026-11-09.json"
import { everySplit } from "../../interleaved"
import rest from "./fixtures/rest-running-trades-2026-11-09.json"
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

const tradingDay = Effect.fnUntraced(function* () {
  // Session 1 has just opened.
  yield* TestClock.setTime(Date.parse("2026-11-09T02:00:01.000Z"))
  const viewers: Array<FakeSocket> = []
  const relays: Array<FakeSocket> = []
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
  }).pipe(Scope.provide(scope))
  const ingest = (socket: FakeSocket, text: string) =>
    day.ingestMessage(socket, text).pipe(Effect.provide(env))
  const relay = yield* Effect.gen(function* () {
    const socket = new FakeSocket()
    relays.push(socket)
    yield* ingest(
      socket,
      yield* encodeIngestUp({
        _tag: "Token",
        protocolVersion: IngestProtocolVersion,
        token: TOKEN,
      })
    )
    return socket
  })
  const send = Effect.fnUntraced(function* (
    message: Parameters<typeof encodeIngestUp>[0]
  ) {
    yield* ingest(relay, yield* encodeIngestUp(message))
  })
  const ajaib = (frames: ReadonlyArray<string>) =>
    send({
      _tag: "Frames",
      protocolVersion: IngestProtocolVersion,
      feed: "Ajaib",
      stream: "trade",
      connection: "A",
      receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:01.000Z"),
      frames,
    })
  const page = (feed: Feed, from: string, to: string, body: string) =>
    send({
      _tag: "BackfillPage",
      protocolVersion: IngestProtocolVersion,
      feed,
      receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:07.000Z"),
      from: TradeNumber.make(from),
      to: TradeNumber.make(to),
      body,
    })
  const viewer = Effect.fnUntraced(function* (selected: string) {
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
    return socket
  })
  // Everything the relay was sent down its ingest socket.
  const requests = Effect.suspend(() =>
    Effect.forEach(relay.sent, (text) => decodeIngestDown(text))
  )
  return { ajaib, page, viewer, requests }
})

const received = (socket: FakeSocket) =>
  Effect.forEach(socket.sent, (text) => decodeViewerDown(text))

const range = (message: IngestDown) =>
  message._tag === "Backfill"
    ? [message.from, message.to, DateTime.formatIso(message.nextTime)]
    : []

// Ajaib's session-1 frames miss seven of Stockbit's numbers: 22322 and
// 22325–22330. Every Ajaib time there is 09:00:00 WIB.
const GAPS = [
  ["22322", "22322", "2026-11-09T02:00:00.000Z"],
  ["22325", "22330", "2026-11-09T02:00:00.000Z"],
]

const numberOf = (frame: string) => Number(JSON.parse(frame).tradeNum.slice(8))

describe("backfill requests under an overlapping gap timer", () => {
  it.effect(
    "a gap opened while the timer asks for an earlier one is still asked for",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.gen(function* () {
            const day = yield* tradingDay()
            // The frames up to 22324 open the first gap; the rest the second.
            yield* day.ajaib(
              recorded.session1.filter((frame) => numberOf(frame) <= 22324)
            )
            return day
          }),
          first: (day) =>
            day.ajaib(
              recorded.session1.filter((frame) => numberOf(frame) > 22324)
            ),
          // The timer wakes inside the adjust and asks for the first gap
          // before the frames' callback resumes.
          second: () => TestClock.adjust("5 seconds"),
          holdFirst: true,
          check: (day, at) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("5 seconds")
              assert.deepStrictEqual(
                (yield* day.requests).map(range),
                GAPS,
                `the frames' callback yielded at operation ${at}`
              )
            }),
        })
        assert.isAbove(operations, 0)
      }),
    60_000
  )
})

describe("backfill requests", () => {
  it.effect(
    "a number still missing 5 s after later ones arrived is asked for",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.ajaib(recorded.session1)
        yield* TestClock.adjust("4999 millis")
        assert.deepStrictEqual(yield* day.requests, [])
        yield* TestClock.adjust("1 millis")
        // The first number seen starts the count: nothing below 22265 is
        // asked for.
        assert.deepStrictEqual((yield* day.requests).map(range), GAPS)
      })
  )

  it.effect("a number that arrives within the 5 s is not asked for", () =>
    Effect.gen(function* () {
      const day = yield* tradingDay()
      const late = recorded.session1.filter((frame) =>
        frame.includes('"tradeNum":"202611090000022300"')
      )
      yield* day.ajaib(
        recorded.session1.filter((frame) => !late.includes(frame))
      )
      yield* TestClock.adjust("3 seconds")
      yield* day.ajaib(late)
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual((yield* day.requests).map(range), GAPS)
    })
  )

  it.effect("a gap is asked for once, and one left unfilled stays silent", () =>
    Effect.gen(function* () {
      const day = yield* tradingDay()
      const watching = yield* day.viewer("BBRI")
      yield* day.ajaib(recorded.session1)
      yield* TestClock.adjust("5 seconds")
      // The broker's page has none of the missing numbers.
      yield* day.page(
        "Stockbit",
        "22322",
        "22330",
        '{"data":{"running_trade":[]}}'
      )
      yield* TestClock.adjust("10 minutes")
      assert.deepStrictEqual((yield* day.requests).map(range), GAPS)
      const messages = yield* received(watching)
      const shown = messages.flatMap((message) =>
        message.tape.map((trade) => String(trade.tradeNumber))
      )
      assert.notInclude(shown, "22322")
      assert.lengthOf(shown, 60)
    })
  )
})

describe("backfilled rows", () => {
  it.effect(
    "a Stockbit REST page fills the gap in place, marked backfill, and resends its minute's candle",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.ajaib(recorded.session1)
        yield* TestClock.adjust("5 seconds")
        const watching = yield* day.viewer("BBRI")
        yield* day.page("Stockbit", "22322", "22330", rest.stockbit)
        yield* TestClock.adjust("250 millis")
        const delta = (yield* received(watching))[1]!
        // 22323 and 22324 were on the page too, but Ajaib had them already.
        assert.deepStrictEqual(
          delta.tape.map((trade): ReadonlyArray<unknown> => [
            trade.tradeNumber,
            trade.code,
            trade.feeds,
          ]),
          [
            ["22322", "BBRI", ["backfill"]],
            ["22325", "TINS", ["backfill"]],
            ["22326", "TINS", ["backfill"]],
            ["22327", "TINS", ["backfill"]],
            ["22328", "TINS", ["backfill"]],
            ["22329", "TINS", ["backfill"]],
            ["22330", "TINS", ["backfill"]],
          ]
        )
        const bbri = delta.tape[0]!
        assert.deepStrictEqual(
          [
            DateTime.formatIso(bbri.time),
            bbri.price,
            bbri.lots,
            bbri.side,
            bbri.board,
          ],
          ["2026-11-09T02:00:00.000Z", 2840, 22, "buy", "RG"]
        )
        // BBRI's 09:00 candle had Ajaib's 35 trades, 858 lots; 22322 adds 22.
        const candle = delta.candles.find((each) => each.code === "BBRI")!
        assert.deepStrictEqual(
          [
            DateTime.formatIso(candle.minute),
            candle.volume,
            candle.frequency,
            candle.close,
          ],
          ["2026-11-09T02:00:00.000Z", 880, 36, 2840]
        )
        // TINS had no trade before: 5 + 1 + 4 + 4 + 1 + 86 lots at 3,430.
        const tins = delta.candles.find((each) => each.code === "TINS")!
        assert.deepStrictEqual(
          [tins.open, tins.volume, tins.frequency, tins.value],
          [3430, 101, 6, 34_643_000]
        )
      })
  )

  it.effect(
    "Ajaib REST pages fill by the last 10 digits of trade_num, and only inside the page's range",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.ajaib(recorded.session1)
        yield* TestClock.adjust("5 seconds")
        const watching = yield* day.viewer("TINS")
        for (const body of rest.ajaib)
          yield* day.page("Ajaib", "22325", "22330", body)
        yield* TestClock.adjust("250 millis")
        const delta = (yield* received(watching))[1]!
        assert.deepStrictEqual(
          delta.tape.map((trade): ReadonlyArray<unknown> => [
            trade.tradeNumber,
            trade.feeds,
            trade.lots,
          ]),
          [
            ["22325", ["backfill"], 5],
            ["22326", ["backfill"], 1],
            ["22327", ["backfill"], 4],
            ["22328", ["backfill"], 4],
            ["22329", ["backfill"], 1],
            ["22330", ["backfill"], 86],
          ]
        )
        // Ajaib's REST time keeps the millisecond.
        assert.strictEqual(
          DateTime.formatIso(delta.tape[0]!.time),
          "2026-11-09T02:00:00.743Z"
        )
      })
  )
})
