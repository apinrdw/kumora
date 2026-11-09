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

const tradingDay = Effect.fnUntraced(function* () {
  const viewers: Array<FakeSocket> = []
  const signedIn = new Map<FakeSocket, SignedIn>()
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: (userId) =>
      Effect.sync(() =>
        viewers.flatMap((peer) => {
          const held = signedIn.get(peer)
          return held?.userId === userId
            ? [{ peer, sessionId: held.sessionId }]
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
  const select = (socket: FakeSocket) =>
    encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: StockCode.make("BBCA"),
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

const tapeOf = (message: ViewerDown) =>
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
        yield* Effect.forEach([laptop, phone, other], select)

        yield* day.endSessions({ userId: "ayu", sessionIds: ["ayu-laptop"] })
        assert.strictEqual(phone.closedWith, ViewerCloseCode.SignInRequired)
        assert.isUndefined(laptop.closedWith)
        assert.isUndefined(other.closedWith)

        yield* day.endSessions({ userId: "ayu", sessionIds: [] })
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
