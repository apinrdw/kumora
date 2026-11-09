// Seam (a) of spec apinrdw/kumora#138: the trading-day Durable Object's
// interface. Recorded Ajaib envelopes go in through the ingest socket, time
// moves only by TestClock, and the test reads what viewers and the relay
// receive.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestCloseCode,
  IngestProtocolVersion,
  StockCode,
  ViewerCloseCode,
  ViewerProtocolVersion,
  WibDate,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type Candle,
  type RunningTrade,
  type ViewerDown,
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
import recordedIhsg from "./fixtures/stockbit-ihsg-liveprice.json"
import recordedStockbit from "./fixtures/stockbit-trades-2026-11-09.json"
import {
  doubleField,
  messageField,
  runningTradeBatch,
  stringField,
  varintField,
  type StockbitRow,
} from "./protobuf"
import { memorySql } from "./sql"
import { AccountId, SessionId } from "@/server/market-live/routes"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  readonly sent: Array<string> = []
  closedWith: number | undefined
  private current: PeerState = "new"
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = (code: number) =>
    Effect.sync(() => {
      this.closedWith = code
    })
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
  // Every viewer message received so far, decoded.
  received = Effect.suspend(() =>
    Effect.forEach(this.sent, (text) => decodeViewerDown(text))
  )
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

// The account and session a viewer socket was tagged with at upgrade.
interface SignedIn {
  readonly userId: string
  readonly sessionId: string
}

const AYU: SignedIn = { userId: "ayu", sessionId: "ayu-laptop" }

// The sessions an account still holds, as the session delete hook sends them.
const heldSessions = (userId: string, sessionIds: ReadonlyArray<string>) => ({
  userId: AccountId.make(userId),
  sessionIds: sessionIds.map((id) => SessionId.make(id)),
})

const tradingDay = Effect.fnUntraced(function* () {
  const viewers: Array<FakeSocket> = []
  const signedIn = new Map<FakeSocket, SignedIn>()
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: (userId) =>
      Effect.sync(() =>
        viewers.flatMap((peer) => {
          const held = signedIn.get(peer)
          return held?.userId === userId
            ? [{ peer, sessionId: SessionId.make(held.sessionId) }]
            : []
        })
      ),
  }).pipe(Scope.provide(scope))
  const ingest = Effect.fnUntraced(function* (
    socket: FakeSocket,
    text: string
  ) {
    return yield* day.ingestMessage(socket, text).pipe(Effect.provide(env))
  })
  const viewer = Effect.fnUntraced(function* (as: SignedIn = AYU) {
    const socket = new FakeSocket()
    viewers.push(socket)
    signedIn.set(socket, as)
    return socket
  })
  const select = (socket: FakeSocket, selected = "BBCA") =>
    encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: StockCode.make(selected),
      watchlist: [],
    }).pipe(Effect.flatMap((text) => day.viewerMessage(socket, text)))
  return { day, ingest, viewer, select }
})

const token = (value: string) =>
  encodeIngestUp({
    _tag: "Token",
    protocolVersion: IngestProtocolVersion,
    token: value,
  })

const ajaib = (frames: ReadonlyArray<string>, connection: "A" | "B" = "A") =>
  encodeIngestUp({
    _tag: "Frames",
    protocolVersion: IngestProtocolVersion,
    feed: "Ajaib",
    stream: "trade",
    connection,
    receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:01.000Z"),
    frames,
  })

// A relay that sent the right token.
const relay = Effect.fnUntraced(function* (
  ingest: (socket: FakeSocket, text: string) => Effect.Effect<void, unknown>
) {
  const socket = new FakeSocket()
  yield* ingest(socket, yield* token(TOKEN))
  return socket
})

const tapeOf = (message: Pick<ViewerDown, "tape">) =>
  message.tape.map((trade) => trade.tradeNumber)

describe("the ingest socket", () => {
  it.effect("a wrong token closes it with 4403, before any frame counts", () =>
    Effect.gen(function* () {
      const { ingest, viewer, select } = yield* tradingDay()
      const socket = new FakeSocket()
      yield* ingest(socket, yield* token("not the token"))
      assert.strictEqual(socket.closedWith, IngestCloseCode.RejectedToken)

      const early = new FakeSocket()
      yield* ingest(early, yield* ajaib(recorded.session1))
      assert.strictEqual(early.closedWith, IngestCloseCode.RejectedToken)

      const page = yield* viewer()
      yield* select(page)
      const [snapshot] = yield* page.received
      assert.deepStrictEqual(snapshot?.tape, [])
    })
  )

  it.effect("an envelope of another protocol version closes it with 4426", () =>
    Effect.gen(function* () {
      const { ingest } = yield* tradingDay()
      const socket = yield* relay(ingest)
      yield* ingest(
        socket,
        JSON.stringify({ _tag: "Token", protocolVersion: 99, token: TOKEN })
      )
      assert.strictEqual(socket.closedWith, IngestCloseCode.VersionMismatch)
    })
  )
})

describe("the viewer socket", () => {
  it.effect("a Select of another protocol version closes it with 4426", () =>
    Effect.gen(function* () {
      const { viewer, day } = yield* tradingDay()
      const page = yield* viewer()
      const text = JSON.stringify({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion + 1,
        selected: "BBCA",
        watchlist: [],
      })
      yield* day.viewerMessage(page, text)
      assert.strictEqual(page.closedWith, ViewerCloseCode.NewVersion)
      assert.lengthOf(page.sent, 0)
    })
  )
})

describe("a ban, revoke or delete", () => {
  it.effect(
    "closes the user's viewer sockets on every session it no longer holds with 4401",
    () =>
      Effect.gen(function* () {
        const { viewer, select, day } = yield* tradingDay()
        const laptop = yield* viewer(AYU)
        const phone = yield* viewer({ userId: "ayu", sessionId: "ayu-phone" })
        const other = yield* viewer({ userId: "budi", sessionId: "budi-1" })
        yield* Effect.forEach([laptop, phone, other], (socket) =>
          select(socket)
        )

        yield* day.endSessions(heldSessions("ayu", ["ayu-laptop"]))
        assert.strictEqual(phone.closedWith, ViewerCloseCode.SignInRequired)
        assert.isUndefined(laptop.closedWith)
        assert.isUndefined(other.closedWith)

        yield* day.endSessions(heldSessions("ayu", []))
        assert.strictEqual(laptop.closedWith, ViewerCloseCode.SignInRequired)
        assert.isUndefined(other.closedWith)
      })
  )
})

describe("running trades from Ajaib", () => {
  it.effect(
    "a viewer's snapshot holds the trades so far, ordered by trade number",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        yield* ingest(socket, yield* ajaib(recorded.session1))

        const page = yield* viewer()
        yield* select(page)
        const [snapshot] = yield* page.received
        assert.strictEqual(snapshot?._tag, "Snapshot")
        const numbers = tapeOf(snapshot!)
        assert.lengthOf(numbers, 60)
        // Ajaib sent 22266 fifteenth and 22269 before 22268; the tape orders
        // them.
        assert.deepStrictEqual(numbers.slice(0, 5), [
          "22265",
          "22266",
          "22267",
          "22268",
          "22269",
        ])
        const first = snapshot!.tape[0]!
        assert.deepStrictEqual(
          {
            code: first.code,
            price: first.price,
            lots: first.lots,
            board: first.board,
            feeds: first.feeds,
            time: DateTime.formatIso(first.time),
          },
          {
            code: StockCode.make("BREN"),
            price: 2130,
            lots: 17,
            board: "RG",
            feeds: ["Ajaib"],
            time: "2026-11-09T02:00:00.000Z",
          }
        )
      })
  )

  it.effect("the snapshot is the 200 newest trades", () =>
    Effect.gen(function* () {
      const { ingest, viewer, select } = yield* tradingDay()
      const socket = yield* relay(ingest)
      const template = JSON.parse(recorded.session1[0]!)
      const frames = Array.from({ length: 250 }, (_, i) =>
        JSON.stringify({
          ...template,
          tradeNum: `20261109${String(30_000 + i).padStart(10, "0")}`,
        })
      )
      yield* ingest(socket, yield* ajaib(frames))
      const page = yield* viewer()
      yield* select(page)
      const [snapshot] = yield* page.received
      const numbers = tapeOf(snapshot!)
      assert.lengthOf(numbers, 200)
      assert.strictEqual(numbers[0], "30050")
      assert.strictEqual(numbers.at(-1), "30249")
    })
  )

  it.effect(
    "deltas arrive every 250 ms, once per trade across connections A and B",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        const idle = yield* viewer()
        yield* select(page)
        const socket = yield* relay(ingest)
        yield* ingest(socket, yield* ajaib(recorded.session1.slice(0, 10), "A"))
        yield* ingest(socket, yield* ajaib(recorded.session1.slice(0, 10), "B"))

        yield* TestClock.adjust("249 millis")
        assert.lengthOf(yield* page.received, 1)
        yield* TestClock.adjust("1 millis")
        const [, delta] = yield* page.received
        assert.strictEqual(delta?._tag, "Delta")
        assert.lengthOf(tapeOf(delta!), 10)
        assert.deepStrictEqual(tapeOf(delta!).slice(0, 3), [
          "22265",
          "22268",
          "22269",
        ])
        // A socket that never sent Select gets no deltas.
        assert.lengthOf(idle.sent, 0)

        yield* ingest(socket, yield* ajaib(recorded.session1.slice(5, 15)))
        yield* TestClock.adjust("250 millis")
        // Only the five not sent before, 22266 below trades already shown.
        const [, , next] = yield* page.received
        assert.deepStrictEqual(tapeOf(next!), [
          "22266",
          "22267",
          "22279",
          "22281",
          "22285",
        ])
      })
  )

  it.effect(
    "the 08:58 opening match has no side, whatever Ajaib's type says",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        yield* ingest(
          socket,
          yield* ajaib([...recorded.openingMatch, ...recorded.session1])
        )
        const page = yield* viewer()
        yield* select(page)
        const [snapshot] = yield* page.received
        const sides = (minute: string) =>
          new Set(
            snapshot!.tape
              .filter((trade) =>
                DateTime.formatIso(trade.time).startsWith(minute)
              )
              .map((trade) => trade.side)
          )
        assert.deepStrictEqual(sides("2026-11-09T01:58"), new Set(["none"]))
        assert.deepStrictEqual(
          sides("2026-11-09T02:00"),
          new Set(["buy", "sell"])
        )
      })
  )

  it.effect("a frame from another trading day is not on this day's tape", () =>
    Effect.gen(function* () {
      const { ingest, viewer, select } = yield* tradingDay()
      const socket = yield* relay(ingest)
      const yesterday = JSON.stringify({
        ...JSON.parse(recorded.session1[0]!),
        tradeNum: "202611060000022265",
      })
      yield* ingest(socket, yield* ajaib([yesterday]))
      const page = yield* viewer()
      yield* select(page)
      const [snapshot] = yield* page.received
      assert.deepStrictEqual(snapshot?.tape, [])
    })
  )
})

// Stockbit's running trades as the 2026-11-09 probe decoded them. The probe
// kept no raw bytes, so `stockbit` encodes the rows back into
// `running_trade_batch` frames.
const stockbitRecorded: {
  readonly openingMatch: ReadonlyArray<StockbitRow>
  readonly session1: ReadonlyArray<StockbitRow>
  readonly boards: ReadonlyArray<StockbitRow>
  readonly ajaibTwins: {
    readonly openingMatch: ReadonlyArray<string>
    readonly tn: ReadonlyArray<string>
  }
} = recordedStockbit

const stockbit = (rows: ReadonlyArray<StockbitRow>, connection: "A" | "B") =>
  encodeIngestUp({
    _tag: "Frames",
    protocolVersion: IngestProtocolVersion,
    feed: "Stockbit",
    connection,
    receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:01.000Z"),
    frames: [runningTradeBatch(rows)],
  })

const snapshotOf = Effect.fnUntraced(function* (
  select: (socket: FakeSocket) => Effect.Effect<void, unknown>,
  viewer: () => Effect.Effect<FakeSocket>
) {
  const page = yield* viewer()
  yield* select(page)
  const [snapshot] = yield* page.received
  return snapshot!.tape
})

const byNumber = (tape: ReadonlyArray<RunningTrade>, tradeNumber: string) =>
  tape.find((trade) => trade.tradeNumber === tradeNumber)!

describe("the merged tape", () => {
  it.effect(
    "a trade from both sites on connections A and B is on it once, with Stockbit's fields",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        for (const connection of ["A", "B"] as const) {
          yield* ingest(socket, yield* ajaib(recorded.session1, connection))
          yield* ingest(
            socket,
            yield* stockbit(stockbitRecorded.session1, connection)
          )
        }
        const tape = yield* snapshotOf(select, viewer)
        const numbers = tape.map((trade) => trade.tradeNumber)
        // 67 numbers, 22265 to 22331, each once: Stockbit saw all of them.
        assert.lengthOf(numbers, 67)
        assert.lengthOf(new Set(numbers), 67)
        assert.strictEqual(numbers[0], "22265")
        assert.strictEqual(numbers.at(-1), "22331")
        const first = byNumber(tape, "22265")
        assert.deepStrictEqual(
          {
            feeds: first.feeds,
            side: first.side,
            lots: first.lots,
            // Stockbit's sub-second time, not Ajaib's whole second.
            time: DateTime.formatIso(first.time),
          },
          {
            feeds: ["Stockbit", "Ajaib"],
            side: "buy",
            lots: 17,
            time: "2026-11-09T02:00:00.002Z",
          }
        )
        const ajaibSaw = new Set(
          recorded.session1.map((frame) =>
            String(Number(JSON.parse(frame).tradeNum.slice(8)))
          )
        )
        const stockbitOnly = tape.filter(
          (trade) => !ajaibSaw.has(trade.tradeNumber)
        )
        assert.lengthOf(stockbitOnly, 7)
        for (const trade of stockbitOnly)
          assert.deepStrictEqual(trade.feeds, ["Stockbit"])
      })
  )

  it.effect(
    "Ajaib fills a side Stockbit left unspecified; Stockbit's board wins",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        // 22265 as Stockbit would send it without an action.
        const { action: _, ...unspecified } = stockbitRecorded.session1[0]!
        const [tn] = stockbitRecorded.boards
        yield* ingest(socket, yield* stockbit([unspecified, tn!], "A"))
        yield* ingest(
          socket,
          yield* ajaib([
            recorded.session1[0]!,
            ...stockbitRecorded.ajaibTwins.tn,
          ])
        )
        const tape = yield* snapshotOf(select, viewer)
        assert.strictEqual(byNumber(tape, "22265").side, "buy")
        // Ajaib's frame has no market_type; Stockbit says TN.
        assert.deepStrictEqual(
          {
            board: byNumber(tape, "26320").board,
            side: byNumber(tape, "26320").side,
          },
          { board: "TN", side: "buy" }
        )
      })
  )

  it.effect(
    "the opening match and negotiated prints have no side, whatever Ajaib's type says",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        const [, ng, oddLot] = stockbitRecorded.boards
        // An Ajaib twin of the negotiated print, typed BUY.
        const ngTwin = JSON.stringify({
          ...JSON.parse(stockbitRecorded.ajaibTwins.tn[0]!),
          ticker: ng!.code,
          type: "BUY",
          tradeNum: `20261109${String(ng!.tradeNumber).padStart(10, "0")}`,
        })
        yield* ingest(
          socket,
          yield* ajaib([...stockbitRecorded.ajaibTwins.openingMatch, ngTwin])
        )
        yield* ingest(
          socket,
          yield* stockbit([...stockbitRecorded.openingMatch, ng!, oddLot!], "B")
        )
        const tape = yield* snapshotOf(select, viewer)
        const match = tape.filter((trade) =>
          DateTime.formatIso(trade.time).startsWith("2026-11-09T01:58:00")
        )
        assert.lengthOf(match, 20)
        for (const trade of match) {
          assert.strictEqual(trade.side, "none")
          assert.deepStrictEqual(trade.feeds, ["Stockbit", "Ajaib"])
        }
        assert.deepStrictEqual(
          {
            board: byNumber(tape, "30536").board,
            side: byNumber(tape, "30536").side,
          },
          { board: "NG", side: "none" }
        )
        // 50 shares on the negotiated board.
        assert.strictEqual(byNumber(tape, "30549").lots, 0.5)
      })
  )

  it.effect(
    "a trade another feed confirms is resent once in a delta, in its place",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        yield* select(page)
        const socket = yield* relay(ingest)
        const rows = stockbitRecorded.session1
        // Stockbit's newer trades first, 22275 onwards.
        yield* ingest(socket, yield* stockbit(rows.slice(10, 20), "A"))
        yield* TestClock.adjust("250 millis")

        // Ajaib, about a second behind, confirms 22275 and brings older ones.
        const late = recorded.session1.filter((frame) =>
          ["22265", "22266", "22275"].includes(
            JSON.parse(frame).tradeNum.slice(-5)
          )
        )
        yield* ingest(socket, yield* ajaib(late, "A"))
        yield* ingest(socket, yield* ajaib(late, "B"))
        // Connection B repeats Stockbit's batch: nothing new.
        yield* ingest(socket, yield* stockbit(rows.slice(10, 20), "B"))
        yield* TestClock.adjust("250 millis")

        const [, first, second] = yield* page.received
        assert.deepStrictEqual(
          tapeOf(first!),
          rows.slice(10, 20).map((row) => String(row.tradeNumber))
        )
        assert.deepStrictEqual(tapeOf(second!), ["22265", "22266", "22275"])
        assert.deepStrictEqual(
          second!.tape.map((trade) => trade.feeds),
          [["Ajaib"], ["Ajaib"], ["Stockbit", "Ajaib"]]
        )
        yield* TestClock.adjust("1 second")
        assert.lengthOf(yield* page.received, 3)

        const tape = yield* snapshotOf(select, viewer)
        assert.deepStrictEqual(tapeOf({ tape }).slice(0, 3), [
          "22265",
          "22266",
          "22275",
        ])
      })
  )
})

// UNTR around the open: the 08:58 opening match from the probe, then made-up
// trades in session 1, two of them off the regular board.
const untr = (
  tradeNumber: number,
  tradeWib: string,
  price: number,
  volume: number,
  board = 1
): StockbitRow => ({
  tradeWib,
  code: "UNTR",
  price,
  volume,
  action: 1,
  board,
  tradeNumber,
})
const untrSession = [
  untr(40001, "09:00:10.000", 23300, 200),
  untr(40002, "09:00:20.000", 23150, 100),
  // A negotiated block and a cash-board print, far off the market.
  untr(40003, "09:00:30.000", 30000, 50000, 3),
  untr(40004, "09:00:40.000", 10000, 100, 2),
  untr(40005, "09:00:59.900", 23250, 300),
  untr(40006, "09:01:05.000", 23275, 100),
]

const figures = (candle: Candle | undefined) =>
  candle && {
    minute: DateTime.formatIso(candle.minute),
    ohlc: [candle.open, candle.high, candle.low, candle.close],
    volume: candle.volume,
    value: candle.value,
    frequency: candle.frequency,
  }

const candlesOf = (
  messages: ReadonlyArray<ViewerDown>,
  code: string
): ReadonlyArray<Candle> =>
  messages.flatMap((message) =>
    message.candles.filter((candle) => candle.code === code)
  )

describe("candles", () => {
  it.effect(
    "RG trades only, each in its own minute; the opening match makes its own candle",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        // Ajaib's copies of the match, typed SELL, change nothing.
        yield* ingest(
          socket,
          yield* ajaib(stockbitRecorded.ajaibTwins.openingMatch)
        )
        yield* ingest(
          socket,
          yield* stockbit(
            [...stockbitRecorded.openingMatch, ...untrSession],
            "A"
          )
        )
        const page = yield* viewer()
        yield* select(page, "UNTR")
        const [snapshot] = yield* page.received
        assert.deepStrictEqual(snapshot!.candles.map(figures), [
          {
            minute: "2026-11-09T01:58:00.000Z",
            ohlc: [23200, 23200, 23200, 23200],
            volume: 54,
            value: 23200 * 5400,
            frequency: 20,
          },
          {
            minute: "2026-11-09T02:00:00.000Z",
            ohlc: [23300, 23300, 23150, 23250],
            volume: 6,
            value: 23300 * 200 + 23150 * 100 + 23250 * 300,
            frequency: 3,
          },
          {
            minute: "2026-11-09T02:01:00.000Z",
            ohlc: [23275, 23275, 23275, 23275],
            volume: 1,
            value: 23275 * 100,
            frequency: 1,
          },
        ])
      })
  )

  it.effect(
    "a late trade resends its own minute's candle, though the next has begun",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        yield* select(page, "UNTR")
        const socket = yield* relay(ingest)
        const [first, ...rest] = untrSession
        yield* ingest(socket, yield* stockbit(rest, "A"))
        yield* TestClock.adjust("250 millis")
        yield* ingest(socket, yield* stockbit([first!], "A"))
        yield* TestClock.adjust("250 millis")

        const [, before, after] = yield* page.received
        assert.deepStrictEqual(
          candlesOf([before!], "UNTR").map((candle) => candle.open),
          [23150, 23275]
        )
        // Only 09:00's candle, now opened by the earlier trade number.
        assert.deepStrictEqual(candlesOf([after!], "UNTR").map(figures), [
          {
            minute: "2026-11-09T02:00:00.000Z",
            ohlc: [23300, 23300, 23150, 23250],
            volume: 6,
            value: 23300 * 200 + 23150 * 100 + 23250 * 300,
            frequency: 3,
          },
        ])
      })
  )

  it.effect(
    "Stockbit's time moves a trade Ajaib rounded into the next minute back to its own",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        const late = untrSession[4]!
        // Ajaib rounds 09:00:59.900 up to 09:01:00.
        const rounded = JSON.stringify({
          ...JSON.parse(stockbitRecorded.ajaibTwins.tn[0]!),
          ticker: late.code,
          type: "BUY",
          price: late.price,
          lot: late.volume / 100,
          tradedAt: "2026-11-09T09:01:00+07:00",
          tradeNum: `20261109${String(late.tradeNumber).padStart(10, "0")}`,
        })
        yield* ingest(socket, yield* ajaib([rounded]))
        const early = yield* viewer()
        yield* select(early, "UNTR")
        const [before] = yield* early.received
        assert.deepStrictEqual(
          before!.candles.map((candle) => DateTime.formatIso(candle.minute)),
          ["2026-11-09T02:01:00.000Z"]
        )

        yield* TestClock.adjust("1 second")
        yield* ingest(socket, yield* stockbit([late], "A"))
        const page = yield* viewer()
        yield* select(page, "UNTR")
        const [snapshot] = yield* page.received
        assert.deepStrictEqual(snapshot!.candles.map(figures), [
          {
            minute: "2026-11-09T02:00:00.000Z",
            ohlc: [23250, 23250, 23250, 23250],
            volume: 3,
            value: 23250 * 300,
            frequency: 1,
          },
        ])
      })
  )

  it.effect("IHSG's candles come from its liveprice frames", () =>
    Effect.gen(function* () {
      const { ingest, viewer, select } = yield* tradingDay()
      const socket = yield* relay(ingest)
      yield* ingest(socket, yield* livePrices(recordedIhsg.ihsg, "A"))
      // Connection B repeats them: nothing counts twice.
      yield* ingest(socket, yield* livePrices(recordedIhsg.ihsg, "B"))
      const page = yield* viewer()
      yield* select(page, "IHSG")
      const [snapshot] = yield* page.received
      assert.deepStrictEqual(snapshot!.candles.map(figures), [
        {
          // The first frame sets the base: only what traded after it counts.
          minute: "2026-11-09T07:15:00.000Z",
          ohlc: [4975.55, 4979.874, 4975.55, 4979.874],
          volume: (23_884_163_300 - 23_883_768_100) / 100,
          value: 4_136_495_385_800 - 4_136_209_751_400,
          frequency: 661_626 - 661_544,
        },
        {
          minute: "2026-11-09T07:19:00.000Z",
          ohlc: [4970.272, 4972.39, 4970.272, 4971.287],
          volume: (24_187_023_700 - 23_884_163_300) / 100,
          value: 4_224_616_955_900 - 4_136_495_385_800,
          frequency: 674_825 - 661_626,
        },
      ])
    })
  )
})

// IHSG's `liveprice` frames from the probe, encoded back into wrapper case 9
// by `LivePrice`'s field numbers. Some frames carry only the totals.
interface LivePriceRow {
  readonly code: string
  readonly date: string
  readonly last?: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

const livePrices = (rows: ReadonlyArray<LivePriceRow>, connection: "A" | "B") =>
  encodeIngestUp({
    _tag: "Frames",
    protocolVersion: IngestProtocolVersion,
    feed: "Stockbit",
    connection,
    receivedAt: DateTime.makeUnsafe("2026-11-09T07:15:37.000Z"),
    frames: rows.map((row) =>
      Uint8Array.from(
        messageField(9, [
          ...stringField(1, row.code),
          ...(row.last === undefined ? [] : doubleField(2, row.last)),
          ...doubleField(3, row.volume),
          ...doubleField(7, row.frequency),
          ...stringField(11, row.date),
          ...doubleField(14, row.value),
          ...varintField(18, 1),
        ])
      )
    ),
  })
