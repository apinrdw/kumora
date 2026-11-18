// Seam (a) of spec apinrdw/kumora#138: the trading-day Durable Object's
// interface. Recorded Ajaib envelopes go in through the ingest socket, time
// moves only by TestClock, and the test reads what viewers and the relay
// receive.
import { assert, describe, it } from "@effect/vitest"
import {
  INGEST_TOKEN_MESSAGE_LIMIT,
  IngestCloseCode,
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  VIEWER_MESSAGE_LIMIT,
  ViewerCloseCode,
  ViewerProtocolVersion,
  WibDate,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  sealInstant,
  type Candle,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import {
  Clock,
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  References,
  Scope,
} from "effect"
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
import { ajaibBefore, stockbitBefore } from "./lagged"
import { memorySql } from "./sql"
import { everySplit } from "../../interleaved"
import { AccountId, SessionId } from "@/server/market-live/routes"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  readonly sent: Array<string> = []
  closedWith: number | undefined
  // A viewer's session end, as the object reads it from the socket's tags.
  sessionEnd?: Effect.Effect<number | undefined>
  // When an ingest socket was accepted, as the object reads it from the
  // socket's tags.
  accepted?: Effect.Effect<number | undefined>
  // A viewer's codes, as the object keeps them in its storage.
  setWatching?: (codes: ReadonlyArray<StockCode>) => Effect.Effect<void>
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

// The account and session a viewer socket was tagged with at upgrade, and
// the session's end; one without an end never expires.
interface SignedIn {
  readonly userId: string
  readonly sessionId: string
  readonly sessionEnd?: DateTime.Utc
}

const AYU: SignedIn = { userId: "ayu", sessionId: "ayu-laptop" }

// The sessions an account still holds, as the session delete hook sends them.
const heldSessions = (userId: string, sessionIds: ReadonlyArray<string>) => ({
  userId: AccountId.make(userId),
  sessionIds: sessionIds.map((id) => SessionId.make(id)),
})

// `woken`: an ingest socket the object already holds when the day is made,
// as one woken from hibernation does. `sql`: the storage an earlier object
// left, for a restart.
const tradingDay = Effect.fnUntraced(function* (
  woken?: FakeSocket,
  sql = memorySql()
) {
  const viewers: Array<FakeSocket> = []
  const relays: Array<FakeSocket> = woken === undefined ? [] : [woken]
  const alarms: Array<DateTime.Utc> = []
  const signedIn = new Map<FakeSocket, SignedIn>()
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql,
    date: DAY,
    viewers: Effect.sync(() => viewers),
    ingests: Effect.sync(() => relays),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
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
  // An ingest socket the object accepted now, its token still to come.
  const open = Effect.fnUntraced(function* () {
    const socket = new FakeSocket()
    socket.accepted = Effect.succeed(yield* Clock.currentTimeMillis)
    relays.push(socket)
    yield* day.ingestOpened
    return socket
  })
  // The Durable Object's alarm firing.
  const alarm = day.alarm.pipe(Effect.provide(env))
  const viewer = Effect.fnUntraced(function* (as: SignedIn = AYU) {
    const socket = new FakeSocket()
    if (as.sessionEnd !== undefined)
      socket.sessionEnd = Effect.succeed(DateTime.toEpochMillis(as.sessionEnd))
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
  return { day, ingest, viewer, select, open, relays, alarms, alarm }
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

  it.effect(
    "a first message past the token limit closes it with 4403 unread; the token at the limit is taken, and the frames after it",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        // The right token, padded with the whitespace JSON allows, to the
        // limit and one past it.
        const tokenText = yield* token(TOKEN)
        const padded = (length: number) =>
          `${tokenText.slice(0, -1)}${" ".repeat(length - tokenText.length)}}`
        const over = new FakeSocket()
        yield* ingest(over, padded(INGEST_TOKEN_MESSAGE_LIMIT + 1))
        assert.strictEqual(over.closedWith, IngestCloseCode.RejectedToken)
        // Not JSON at all: refused by its length, before any parse.
        const garbage = new FakeSocket()
        yield* ingest(garbage, "x".repeat(INGEST_TOKEN_MESSAGE_LIMIT + 1))
        assert.strictEqual(garbage.closedWith, IngestCloseCode.RejectedToken)

        const socket = new FakeSocket()
        yield* ingest(socket, padded(INGEST_TOKEN_MESSAGE_LIMIT))
        assert.strictEqual(socket.closedWith, undefined)
        assert.strictEqual(yield* socket.state, "ready")
        const frames = yield* ajaib(recorded.session1)
        assert.isAbove(frames.length, INGEST_TOKEN_MESSAGE_LIMIT)
        yield* ingest(socket, frames)
        const page = yield* viewer()
        yield* select(page)
        const [snapshot] = yield* page.received
        assert.strictEqual(snapshot?.tape.length, recorded.session1.length)
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

  it.effect(
    "a malformed first message closes it with 4403: not JSON, or a Token without its token; another version's first message still closes with 4426",
    () =>
      Effect.gen(function* () {
        const { ingest } = yield* tradingDay()
        const notJson = new FakeSocket()
        yield* ingest(notJson, "{not json")
        assert.strictEqual(notJson.closedWith, IngestCloseCode.RejectedToken)
        const tokenless = new FakeSocket()
        yield* ingest(
          tokenless,
          JSON.stringify({
            _tag: "Token",
            protocolVersion: IngestProtocolVersion,
          })
        )
        assert.strictEqual(tokenless.closedWith, IngestCloseCode.RejectedToken)
        assert.strictEqual(yield* tokenless.state, "new")
        const otherVersion = new FakeSocket()
        yield* ingest(
          otherVersion,
          JSON.stringify({ _tag: "Token", protocolVersion: 99, token: TOKEN })
        )
        assert.strictEqual(
          otherVersion.closedWith,
          IngestCloseCode.VersionMismatch
        )
      })
  )
})

// The epoch ms the alarm was last set for.
const lastAlarm = (alarms: ReadonlyArray<DateTime.Utc>) =>
  DateTime.toEpochMillis(alarms[alarms.length - 1]!)

describe("the ingest socket's token deadline", () => {
  const start = DateTime.makeUnsafe("2026-11-09T02:00:00.000Z")
  const at = (seconds: number) =>
    DateTime.toEpochMillis(DateTime.add(start, { seconds }))

  it.effect(
    "a socket silent for 10 s is closed with 4408 at the alarm, which is armed a deadline on while one has time, then for the seal",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(start))
        const { ingest, open, alarms, alarm } = yield* tradingDay()
        // The seal's, set when the day was made.
        assert.lengthOf(alarms, 1)
        const silent = yield* open()
        assert.strictEqual(lastAlarm(alarms), at(10))

        yield* TestClock.adjust("5 seconds")
        const later = yield* open()
        const ready = yield* open()
        yield* ingest(ready, yield* token(TOKEN))
        // No wake earlier than the one armed.
        assert.lengthOf(alarms, 2)

        yield* TestClock.adjust("5 seconds")
        yield* alarm
        assert.strictEqual(silent.closedWith, IngestCloseCode.TokenOverdue)
        assert.isUndefined(later.closedWith)
        assert.isUndefined(ready.closedWith)
        assert.strictEqual(lastAlarm(alarms), at(20))

        yield* TestClock.adjust("10 seconds")
        yield* alarm
        assert.strictEqual(later.closedWith, IngestCloseCode.TokenOverdue)
        assert.isUndefined(ready.closedWith)
        assert.strictEqual(
          lastAlarm(alarms),
          DateTime.toEpochMillis(yield* sealInstant(DAY))
        )
      })
  )

  it.effect(
    "a socket without a token and no accept instant is closed at the next alarm, and at the day's start",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(start))
        const { relays, alarm } = yield* tradingDay()
        const untimed = new FakeSocket()
        relays.push(untimed)
        yield* alarm
        assert.strictEqual(untimed.closedWith, IngestCloseCode.TokenOverdue)

        const held = new FakeSocket()
        const woken = yield* tradingDay(held)
        assert.strictEqual(held.closedWith, IngestCloseCode.TokenOverdue)
        assert.lengthOf(woken.alarms, 1)
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

  it.effect(
    "the largest Select is served, at the message limit too; a message past the limit closes it with 1011 unread",
    () =>
      Effect.gen(function* () {
        const { viewer, day } = yield* tradingDay()
        const longest = Array.from({ length: 10_000 }, (_, index) =>
          StockCode.make(`TN.W${String(index).padStart(12, "0")}`)
        )
        const largest = yield* encodeViewerUp({
          _tag: "Select",
          protocolVersion: ViewerProtocolVersion,
          selected: longest[0]!,
          watchlist: longest,
        })
        assert.isAtMost(largest.length, VIEWER_MESSAGE_LIMIT)
        const page = yield* viewer()
        yield* day.viewerMessage(page, largest)
        const [snapshot] = yield* page.received
        assert.strictEqual(
          snapshot?._tag === "Snapshot" && snapshot.selected,
          longest[0]
        )
        // The largest Select, padded with the whitespace JSON allows, to the
        // limit and one past it.
        const padded = (length: number) =>
          `${largest.slice(0, -1)}${" ".repeat(length - largest.length)}}`
        const atLimit = yield* viewer()
        yield* day.viewerMessage(atLimit, padded(VIEWER_MESSAGE_LIMIT))
        assert.isUndefined(atLimit.closedWith)
        assert.lengthOf(yield* atLimit.received, 1)
        const over = yield* viewer()
        yield* day.viewerMessage(over, padded(VIEWER_MESSAGE_LIMIT + 1))
        assert.strictEqual(over.closedWith, ViewerCloseCode.SelectNotServed)
        assert.lengthOf(over.sent, 0)
        // Not JSON at all: refused by its length, before any parse, so it
        // doesn't fail as a Select the object couldn't serve.
        const garbage = yield* viewer()
        const exit = yield* Effect.exit(
          day.viewerMessage(garbage, "x".repeat(VIEWER_MESSAGE_LIMIT + 1))
        )
        assert.isTrue(Exit.isSuccess(exit))
        assert.strictEqual(garbage.closedWith, ViewerCloseCode.SelectNotServed)
        assert.lengthOf(garbage.sent, 0)
      })
  )

  it.effect("a snapshot names the code its Select selected", () =>
    Effect.gen(function* () {
      const { viewer, select } = yield* tradingDay()
      const page = yield* viewer()
      yield* select(page, "BBRI")
      const [snapshot] = yield* page.received
      assert.strictEqual(
        snapshot?._tag === "Snapshot" && snapshot.selected,
        StockCode.make("BBRI")
      )
    })
  )

  it.effect(
    "a Select whose codes couldn't be kept closes it with 1011, so the page reconnects",
    () =>
      Effect.gen(function* () {
        const { viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        // The object's storage refusing the write.
        page.setWatching = () => Effect.die(new Error("Storage write failed"))
        const exit = yield* Effect.exit(select(page))
        assert.isTrue(Exit.isFailure(exit))
        assert.strictEqual(page.closedWith, ViewerCloseCode.SelectNotServed)
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

describe("a session's end", () => {
  const start = DateTime.makeUnsafe("2026-11-09T02:00:00.000Z")
  const expiring: SignedIn = {
    userId: "ayu",
    sessionId: "ayu-hour",
    sessionEnd: DateTime.add(start, { hours: 1 }),
  }

  it.effect(
    "a viewer whose session ended is closed with 4401 at its next delta, and sent nothing more",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(start))
        const { ingest, viewer, select } = yield* tradingDay()
        const page = yield* viewer(expiring)
        const other = yield* viewer(AYU)
        yield* select(page)
        yield* select(other)
        const socket = yield* relay(ingest)
        yield* ingest(socket, yield* ajaib(recorded.session1.slice(0, 10)))
        yield* TestClock.adjust("250 millis")
        assert.lengthOf(page.sent, 2)
        assert.isUndefined(page.closedWith)

        // The market conditions change over the hour; those deltas still go
        // to both.
        yield* TestClock.adjust("1 hour")
        assert.isUndefined(page.closedWith)
        const sent = page.sent.length
        const otherSent = other.sent.length
        yield* ingest(socket, yield* ajaib(recorded.session1.slice(10, 20)))
        yield* TestClock.adjust("250 millis")
        assert.strictEqual(page.closedWith, ViewerCloseCode.SignInRequired)
        assert.lengthOf(page.sent, sent)
        assert.isUndefined(other.closedWith)
        assert.lengthOf(other.sent, otherSent + 1)
      })
  )

  it.effect(
    "a Select on an ended session is answered with 4401, not a snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.add(start, { hours: 1 }))
        )
        const { viewer, select } = yield* tradingDay()
        const page = yield* viewer(expiring)
        yield* select(page)
        assert.strictEqual(page.closedWith, ViewerCloseCode.SignInRequired)
        assert.lengthOf(page.sent, 0)
      })
  )
})

describe("the day's end", () => {
  // 23:59:59.900 WIB on the object's day.
  const beforeMidnight = DateTime.makeUnsafe("2026-11-09T16:59:59.900Z")

  it.effect(
    "a viewer is closed with 1001 at its next delta once the clock's date passed the day, and sent nothing more",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(beforeMidnight))
        const { ingest, viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        yield* select(page)
        assert.lengthOf(page.sent, 1)
        const socket = yield* relay(ingest)
        yield* ingest(socket, yield* ajaib(recorded.session1.slice(0, 10)))
        // The delta falls past midnight.
        yield* TestClock.adjust("250 millis")
        assert.strictEqual(page.closedWith, ViewerCloseCode.DayEnded)
        assert.lengthOf(page.sent, 1)
      })
  )

  it.effect(
    "a Select once the clock's date passed the day is answered with 1001, not a snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.add(beforeMidnight, { seconds: 1 }))
        )
        const { viewer, select } = yield* tradingDay()
        const page = yield* viewer()
        yield* select(page)
        assert.strictEqual(page.closedWith, ViewerCloseCode.DayEnded)
        assert.lengthOf(page.sent, 0)
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

describe("the merged tape under overlapping ingest callbacks", () => {
  it.effect(
    "a batch delivered by both connections, one callback yielding mid-way, leaves each trade on it once, in order",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.gen(function* () {
            const { ingest, viewer, select } = yield* tradingDay()
            const socket = yield* relay(ingest)
            const batch = (connection: "A" | "B") =>
              Effect.flatMap(
                stockbit(stockbitRecorded.session1, connection),
                (text) => ingest(socket, text)
              )
            return { batch, viewer, select }
          }),
          first: ({ batch }) => batch("A"),
          second: ({ batch }) => batch("B"),
          check: ({ select, viewer }, at) =>
            Effect.gen(function* () {
              const tape = yield* snapshotOf(select, viewer)
              const numbers = tape.map((trade) => trade.tradeNumber)
              assert.deepStrictEqual(
                numbers,
                [...new Set(numbers)].sort((a, b) => Number(a) - Number(b)),
                `connection A's callback yielded at operation ${at}`
              )
              assert.lengthOf(
                numbers,
                67,
                `connection A's callback yielded at operation ${at}`
              )
            }),
        })
        assert.isAbove(operations, 0)
      }),
    120_000
  )
})

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

  it.effect(
    "Stockbit's copy of a trade the full tape evicted still corrects its candle inside the merge window",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        const template = JSON.parse(recorded.session1[0]!)
        // 10,001 BREN trades at 2130 in one minute: the lowest number leaves
        // the tape as the 10,001st arrives.
        const frames = Array.from({ length: 10_001 }, (_, i) =>
          JSON.stringify({
            ...template,
            tradeNum: `20261109${String(30_000 + i).padStart(10, "0")}`,
          })
        )
        yield* ingest(socket, yield* ajaib(frames))
        // Stockbit's copy of the evicted trade, 224 ms later, at 2200.
        yield* TestClock.adjust("224 millis")
        yield* ingest(
          socket,
          yield* stockbit(
            [
              {
                tradeWib: "09:00:00.500",
                code: "BREN",
                price: 2200,
                volume: 1700,
                action: 1,
                board: 1,
                tradeNumber: 30_000,
              },
            ],
            "A"
          )
        )
        const page = yield* viewer()
        yield* select(page, "BREN")
        const [snapshot] = yield* page.received
        const [candle] = snapshot!.candles
        // The evicted trade opens the minute's candle: Stockbit's price.
        assert.deepStrictEqual(
          {
            open: candle?.open,
            high: candle?.high,
            frequency: candle?.frequency,
          },
          { open: 2200, high: 2200, frequency: 10_001 }
        )
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

  it.effect(
    "a delta's and a snapshot's candles carry the value bought and sold; the opening match counts in value only",
    () =>
      Effect.gen(function* () {
        const { ingest, viewer, select } = yield* tradingDay()
        const live = yield* viewer()
        yield* select(live, "UNTR")
        const socket = yield* relay(ingest)
        yield* ingest(
          socket,
          yield* stockbit(
            [
              ...stockbitRecorded.openingMatch,
              untr(40001, "09:00:10.000", 23300, 200),
              { ...untr(40002, "09:00:20.000", 23150, 100), action: 2 },
            ],
            "A"
          )
        )
        yield* TestClock.adjust("250 millis")
        const split = (candle: Candle) => ({
          minute: DateTime.formatIso(candle.minute),
          value: candle.value,
          buyValue: candle.buyValue,
          sellValue: candle.sellValue,
        })
        const expected = [
          {
            minute: "2026-11-09T01:58:00.000Z",
            value: 23200 * 5400,
            buyValue: 0,
            sellValue: 0,
          },
          {
            minute: "2026-11-09T02:00:00.000Z",
            value: 23300 * 200 + 23150 * 100,
            buyValue: 23300 * 200,
            sellValue: 23150 * 100,
          },
        ]
        const [, delta] = yield* live.received
        assert.deepStrictEqual(candlesOf([delta!], "UNTR").map(split), expected)
        const page = yield* viewer()
        yield* select(page, "UNTR")
        const [snapshot] = yield* page.received
        assert.deepStrictEqual(snapshot!.candles.map(split), expected)
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

// Spec apinrdw/kumora#510 (tickets apinrdw/kumora#512 and #513): the object
// decides each code's sweep alerts once a sweep's second closes, whatever
// viewers selected, sends them in the next delta, and a restarted one ranks the stored sweeps before it alerts.
describe("sweep alerts", () => {
  // 100 one-lot buy sweeps of UNTR, one a second from 09:00:00 WIB, numbered
  // from `first`: its buy side's warm-up.
  const warmUntr = (first: number) =>
    Array.from({ length: 100 }, (_, index) =>
      untr(
        first + index,
        `09:0${Math.floor(index / 60)}:${String(index % 60).padStart(2, "0")}.000`,
        23300,
        100
      )
    )

  it.effect(
    "a delta carries a code's alert, with its sweep's trade numbers, though no viewer selected the code",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(wibAt("09:01:42.500")))
        const { ingest, viewer, select } = yield* tradingDay()
        const socket = yield* relay(ingest)
        const page = yield* viewer()
        yield* select(page, "BBCA")
        yield* ingest(
          socket,
          yield* stockbit(
            [
              ...warmUntr(41000),
              // A negotiated block never alerts.
              untr(41100, "09:01:40.100", 23300, 90_000, 3),
              untr(41101, "09:01:41.100", 23300, 4000),
              untr(41102, "09:01:41.200", 23325, 6000),
              // A later second closes the big sweep's.
              { ...untr(41103, "09:01:42.000", 8000, 100), code: "BBCA" },
            ],
            "A"
          )
        )
        yield* TestClock.adjust("250 millis")
        const deltas = (yield* page.received).filter(
          (message) => message._tag === "Delta"
        )
        assert.deepStrictEqual(
          deltas.flatMap((delta) => delta.sweepAlerts ?? []),
          [
            {
              code: StockCode.make("UNTR"),
              side: "buy",
              lots: 100,
              tradeNumbers: [
                TradeNumber.make("41101"),
                TradeNumber.make("41102"),
              ],
            },
          ]
        )
        // UNTR's sweeps themselves go only to a viewer that selected it.
        assert.deepStrictEqual(
          deltas.flatMap((delta) =>
            (delta.sweeps ?? []).map((minute) => minute.code)
          ),
          []
        )
      })
  )

  it.effect(
    "a restarted object ranks the stored sweeps first, so a side warmed up before it still alerts",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(wibAt("09:01:42.500")))
        const sql = memorySql()
        const before = yield* tradingDay(undefined, sql)
        yield* before.ingest(
          yield* relay(before.ingest),
          yield* stockbit(warmUntr(41000), "A")
        )
        // Past the merge window, the flush stores the warm-up's sweeps.
        yield* TestClock.adjust("30 seconds")
        yield* before.alarm

        const { ingest, viewer, select } = yield* tradingDay(undefined, sql)
        const page = yield* viewer()
        yield* select(page, "BBCA")
        yield* ingest(
          yield* relay(ingest),
          yield* stockbit(
            [
              untr(41101, "09:02:10.100", 23300, 4000),
              untr(41102, "09:02:10.200", 23325, 6000),
              { ...untr(41103, "09:02:11.000", 8000, 100), code: "BBCA" },
            ],
            "A"
          )
        )
        yield* TestClock.adjust("250 millis")
        const deltas = (yield* page.received).filter(
          (message) => message._tag === "Delta"
        )
        assert.deepStrictEqual(
          deltas.flatMap((delta) => delta.sweepAlerts ?? []),
          [
            {
              code: StockCode.make("UNTR"),
              side: "buy",
              lots: 100,
              tradeNumbers: [
                TradeNumber.make("41101"),
                TradeNumber.make("41102"),
              ],
            },
          ]
        )
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

// The fields of one "Feed lag" log line.
interface FeedLagLine {
  readonly feed: string
  readonly minute: string
  readonly trades: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

// Runs `test` with every "Feed lag" line logged meanwhile, the minute
// flush's included, collected into the array it is handed.
const withFeedLagLines = <A, E, R>(
  test: (lines: ReadonlyArray<FeedLagLine>) => Effect.Effect<A, E, R>
) => {
  const lines: Array<FeedLagLine> = []
  const capture = Logger.make(({ message, fiber }) => {
    const [text] = Array.isArray(message) ? message : [message]
    if (text === "Feed lag")
      lines.push(
        fiber.getRef(References.CurrentLogAnnotations) as unknown as FeedLagLine
      )
  })
  return test(lines).pipe(Effect.provide(Logger.layer([capture])))
}

const wibAt = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)

// A Stockbit backfill page holding one BBCA trade at `wib`.
const stockbitPage = (tradeNumber: string, wib: string) =>
  encodeIngestUp({
    _tag: "BackfillPage",
    protocolVersion: IngestProtocolVersion,
    feed: "Stockbit",
    receivedAt: DateTime.makeUnsafe("2026-11-09T03:00:30.000Z"),
    from: TradeNumber.make(tradeNumber),
    to: TradeNumber.make(tradeNumber),
    body: JSON.stringify({
      data: {
        date: "2026-11-09",
        running_trade: [
          {
            trade_number: tradeNumber,
            time: wib,
            code: "BBCA",
            price: "9,000",
            lot: "1",
            action: "buy",
          },
        ],
      },
    }),
  })

const TEN = wibAt("10:00:00.000")
const MINUTE_TEN = "2026-11-09T03:00:00.000Z"

describe("the per-minute feed lag log", () => {
  it.effect(
    "each feed that relayed trades in a minute gets one line with its count, p50, p99 and max",
    () =>
      withFeedLagLines((lines) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
          const { ingest } = yield* tradingDay()
          const socket = yield* relay(ingest)
          // Stockbit's ten trail the clock by 100 ms to 1 s.
          const rows = Array.from({ length: 10 }, (_, i) =>
            stockbitBefore(50_001 + i, TEN, 100 * (i + 1))
          )
          yield* ingest(socket, yield* stockbit(rows, "A"))
          // Ajaib's four by 1 s to 4 s.
          yield* ingest(
            socket,
            yield* ajaib(
              [1, 2, 3, 4].map((i) => ajaibBefore(60_000 + i, TEN, 1000 * i))
            )
          )
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:04.999"))
          )
          assert.deepStrictEqual(lines, [])
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:05.000"))
          )
          assert.deepStrictEqual(lines, [
            {
              feed: "Stockbit",
              minute: MINUTE_TEN,
              trades: 10,
              p50Ms: 500,
              p99Ms: 1000,
              maxMs: 1000,
            },
            {
              feed: "Ajaib",
              minute: MINUTE_TEN,
              trades: 4,
              p50Ms: 2000,
              p99Ms: 4000,
              maxMs: 4000,
            },
          ])
        })
      )
  )

  it.effect(
    "connection B's copy, a late copy and a backfilled trade change neither the count nor the percentiles",
    () =>
      withFeedLagLines((lines) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
          const { ingest } = yield* tradingDay()
          const socket = yield* relay(ingest)
          const rows = [
            stockbitBefore(50_001, TEN, 200),
            stockbitBefore(50_002, TEN, 400),
          ]
          yield* ingest(socket, yield* stockbit(rows, "A"))
          yield* TestClock.adjust("300 millis")
          yield* ingest(socket, yield* stockbit(rows, "B"))
          yield* TestClock.adjust("20 seconds")
          yield* ingest(socket, yield* stockbit(rows, "B"))
          // A page fills a number the feeds missed, ten minutes old.
          yield* ingest(socket, yield* stockbitPage("50003", "09:50:00"))
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:05.000"))
          )
          assert.deepStrictEqual(lines, [
            {
              feed: "Stockbit",
              minute: MINUTE_TEN,
              trades: 2,
              p50Ms: 200,
              p99Ms: 400,
              maxMs: 400,
            },
          ])
        })
      )
  )

  it.effect(
    "connection B's copy of a trade held only outside the tape isn't timed again",
    () =>
      withFeedLagLines((lines) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
          const { ingest } = yield* tradingDay()
          const socket = yield* relay(ingest)
          // A full tape and one more, all on Ajaib alone: trade 1 is evicted.
          for (let batch = 0; batch < 10; batch++)
            yield* ingest(
              socket,
              yield* ajaib(
                Array.from({ length: 1_001 }, (_, i) =>
                  ajaibBefore(1 + batch * 1_001 + i, TEN, 1000)
                )
              )
            )
          // Past trade 1's merge window.
          yield* TestClock.adjust("10 seconds")
          const now = yield* DateTime.now
          const rows = [stockbitBefore(1, now, 10_000)]
          yield* ingest(socket, yield* stockbit(rows, "A"))
          yield* TestClock.adjust("300 millis")
          yield* ingest(socket, yield* stockbit(rows, "B"))
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:05.000"))
          )
          assert.deepStrictEqual(
            lines
              .filter((line) => line.feed === "Stockbit")
              .map((line) => [line.trades, line.maxMs]),
            [[1, 10_000]]
          )
        })
      ),
    60_000
  )

  it.effect(
    "connection B's copy of a trade timed on the tape isn't timed again once the tape and merge window lost it",
    () =>
      withFeedLagLines((lines) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
          const { ingest } = yield* tradingDay()
          const socket = yield* relay(ingest)
          // 10,010 trades on connection A: trades 1 to 10 are evicted.
          for (let batch = 0; batch < 10; batch++)
            yield* ingest(
              socket,
              yield* ajaib(
                Array.from({ length: 1_001 }, (_, i) =>
                  ajaibBefore(1 + batch * 1_001 + i, TEN, 1000)
                )
              )
            )
          // Past their merge windows.
          yield* TestClock.adjust("11 seconds")
          yield* ingest(
            socket,
            yield* ajaib(
              [1, 2, 3].map((n) => ajaibBefore(n, TEN, 1000)),
              "B"
            )
          )
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:05.000"))
          )
          assert.deepStrictEqual(
            lines.map((line) => [line.feed, line.trades, line.maxMs]),
            [["Ajaib", 10_010, 1000]]
          )
        })
      ),
    60_000
  )

  it.effect(
    "a trade one feed relayed first is timed for the other feed at its first copy",
    () =>
      withFeedLagLines((lines) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
          const { ingest } = yield* tradingDay()
          const socket = yield* relay(ingest)
          yield* ingest(
            socket,
            yield* stockbit([stockbitBefore(50_001, TEN, 300)], "A")
          )
          yield* TestClock.adjust("2 seconds")
          // Ajaib's copy: its whole-second time is 1 s before TEN.
          yield* ingest(socket, yield* ajaib([ajaibBefore(50_001, TEN, 1000)]))
          yield* TestClock.setTime(
            DateTime.toEpochMillis(wibAt("10:01:05.000"))
          )
          assert.deepStrictEqual(
            lines.map((line) => [line.feed, line.trades, line.maxMs]),
            [
              ["Stockbit", 1, 300],
              ["Ajaib", 1, 3000],
            ]
          )
        })
      )
  )

  it.effect("a minute with no trades for a feed writes no line for it", () =>
    withFeedLagLines((lines) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(TEN))
        const { ingest } = yield* tradingDay()
        const socket = yield* relay(ingest)
        yield* ingest(socket, yield* ajaib([ajaibBefore(60_001, TEN, 1000)]))
        const later = wibAt("10:01:30.000")
        yield* TestClock.setTime(DateTime.toEpochMillis(later))
        yield* ingest(
          socket,
          yield* stockbit([stockbitBefore(50_001, later, 250)], "A")
        )
        yield* TestClock.setTime(DateTime.toEpochMillis(wibAt("10:04:05.000")))
        assert.deepStrictEqual(
          lines.map((line) => [line.feed, line.minute, line.trades]),
          [
            ["Ajaib", MINUTE_TEN, 1],
            ["Stockbit", "2026-11-09T03:01:00.000Z", 1],
          ]
        )
      })
    )
  )
})
