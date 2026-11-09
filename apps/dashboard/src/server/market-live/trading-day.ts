// The trading-day Durable Object's behaviour, apart from Cloudflare (spec
// apinrdw/kumora#138, "The trading-day Durable Object" and "The viewer
// protocol"). trading-day-object.ts adapts it to the Durable Object and its
// hibernatable sockets; the tests drive it with fake sockets and TestClock.
// Time is read only through Effect's Clock.
import {
  IngestCloseCode,
  TradeNumberOrder,
  ViewerCloseCode,
  decodeIngestUp,
  decodeViewerUp,
  encodeViewerDown,
  MarketStatus,
  marketMomentAt,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema, Scope } from "effect"

import { ajaibTrades } from "./ajaib.ts"
import { makeMarketStatus } from "./market-status.ts"
import type { HeldSessions } from "./routes.ts"
import { stockbitTrades } from "./stockbit.ts"

// A socket's progress. An ingest socket is `ready` once its token checked out;
// a viewer socket once it was sent a snapshot, and from then on gets deltas.
export type PeerState = "new" | "ready"

// One accepted websocket. Its state lives with the socket, so it survives the
// object hibernating.
export interface Peer {
  readonly send: (text: string) => Effect.Effect<void>
  readonly close: (code: number, reason: string) => Effect.Effect<void>
  readonly state: Effect.Effect<PeerState>
  readonly setState: (state: PeerState) => Effect.Effect<void>
}

// A viewer socket and the session it was gated with.
export interface SessionViewer {
  readonly peer: Peer
  readonly sessionId: string
}

const SNAPSHOT_TRADES = 200

// How often viewers get the trades that arrived since the last delta.
const DELTA_INTERVAL = "250 millis"

// Decision: the tape lives in memory, bounded to the newest 10,000 trades, the
// most the page keeps. Storage, and dedupe of a trade older than the window,
// arrive with the recorded day ticket (apinrdw/kumora#151); until then a
// restart starts the tape empty.
const TAPE_LIMIT = 10_000

// The tape ordered by trade number, ascending; the index where `trade` sits or
// would be inserted.
const positionOf = (
  tape: ReadonlyArray<RunningTrade>,
  trade: RunningTrade
): number => {
  let low = 0
  let high = tape.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (TradeNumberOrder(tape[middle]!.tradeNumber, trade.tradeNumber) < 0)
      low = middle + 1
    else high = middle
  }
  return low
}

// A merged trade lists its feeds in this order.
const FEEDS: ReadonlyArray<RunningTrade["feeds"][number]> = [
  "Stockbit",
  "Ajaib",
  "backfill",
]

// One trade as two feeds saw it (spec apinrdw/kumora#138, "Merge and
// dedupe"): Stockbit's fields win, sub-second time included; the other feed
// fills only a side Stockbit left unspecified.
const merge = (held: RunningTrade, arriving: RunningTrade): RunningTrade => {
  const arrivingWins =
    arriving.feeds.includes("Stockbit") && !held.feeds.includes("Stockbit")
  const [first, second] = arrivingWins ? [arriving, held] : [held, arriving]
  return {
    ...first,
    side: first.side === "none" ? second.side : first.side,
    feeds: FEEDS.filter(
      (feed) => first.feeds.includes(feed) || second.feeds.includes(feed)
    ),
  }
}

// Decision: the auction matches (08:58:00 and 16:00:00, inside pre-opening
// and pre-closing) and the negotiated board have no side, whichever feed
// claims one: Ajaib types about 99.5% of match prints SELL. Applied to the
// merged trade, so an Ajaib side can't fill a match or an NG print that
// Stockbit left unspecified. The cash board (TN) keeps its side: Stockbit
// sends a real aggressor there.
const settleSide = Effect.fnUntraced(function* (trade: RunningTrade) {
  if (trade.side === "none") return trade
  const { phase } = yield* marketMomentAt(trade.time)
  const sideless =
    trade.board === "NG" || phase === "pre-opening" || phase === "pre-closing"
  return sideless ? { ...trade, side: "none" as const } : trade
})

// How often the object checks whether the market status changed: a feed
// going stale is noticed within this.
const STATUS_INTERVAL = "1 second"

const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(MarketStatus))

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toString()))

export const makeTradingDay = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  // Every viewer socket the object holds, ready or not.
  readonly viewers: Effect.Effect<ReadonlyArray<Peer>>
  // The viewer sockets of one account, on any of its sessions.
  readonly viewersOf: (
    userId: string
  ) => Effect.Effect<ReadonlyArray<SessionViewer>>
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  const tape: Array<RunningTrade> = []
  // Trades viewers haven't been sent since the last delta, new or changed,
  // by trade number.
  let pending = new Map<string, RunningTrade>()
  let deltaScheduled = false
  const market = yield* makeMarketStatus(options.date)
  // The market status viewers were last sent, encoded.
  let sentStatus = ""
  let relayOnline = false
  let checking = false

  // Merges each trade into the tape: a new trade number is inserted in its
  // place, a known one merged with what other feeds saw. A trade older than a
  // full tape's oldest is dropped: it can't be told from one already evicted.
  const insert = Effect.fnUntraced(function* (
    trades: ReadonlyArray<RunningTrade>
  ) {
    for (const arriving of trades) {
      const at = positionOf(tape, arriving)
      const held = tape[at]
      if (held?.tradeNumber === arriving.tradeNumber) {
        const merged = yield* settleSide(merge(held, arriving))
        if (
          merged.feeds.length === held.feeds.length &&
          merged.side === held.side
        )
          continue
        tape[at] = merged
        pending.set(merged.tradeNumber, merged)
        continue
      }
      if (at === 0 && tape.length >= TAPE_LIMIT) continue
      const trade = yield* settleSide(arriving)
      tape.splice(at, 0, trade)
      if (tape.length > TAPE_LIMIT) tape.shift()
      pending.set(trade.tradeNumber, trade)
    }
  })

  const sendDelta = Effect.gen(function* () {
    deltaScheduled = false
    const trades = [...pending.values()].sort((a, b) =>
      TradeNumberOrder(a.tradeNumber, b.tradeNumber)
    )
    pending = new Map()
    const status = yield* market.status
    const encoded = yield* encodeStatus(status)
    const statusChanged = encoded !== sentStatus
    sentStatus = encoded
    const indicative = yield* market.indicativeChanges
    if (trades.length === 0 && !statusChanged && indicative.length === 0) return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      tape: trades,
      ...(statusChanged ? { status } : {}),
      ...(indicative.length > 0 ? { indicative } : {}),
    })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) === "ready") yield* viewer.send(text)
    }
  })

  const scheduleDelta = Effect.suspend(() => {
    if (deltaScheduled) return Effect.void
    deltaScheduled = true
    return Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(sendDelta),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope),
      Effect.asVoid
    )
  })

  // Decision: while a relay or a viewer is connected, the object looks at the
  // market status every second and sends a delta when it changed, so a feed
  // going stale or the phase turning reaches viewers without a frame. Alone,
  // it stops, and the object can hibernate.
  const checkStatus: Effect.Effect<void> = Effect.suspend(() => {
    if (checking) return Effect.void
    checking = true
    const loop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sleep(STATUS_INTERVAL)
      if (!relayOnline && (yield* options.viewers).length === 0) {
        checking = false
        return
      }
      yield* scheduleDelta
      yield* loop
    })
    return loop.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Status not checked", cause)
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    )
  })

  const tokenMatches = Effect.fnUntraced(function* (token: string) {
    const { INGEST_TOKEN } = yield* WorkerEnv
    return (yield* sha256(token)) === (yield* sha256(INGEST_TOKEN))
  })

  // One envelope from the relay. The token comes first; anything before it, or
  // a wrong one, closes the socket with 4403.
  const ingestMessage = Effect.fnUntraced(
    function* (socket: Peer, text: string) {
      const message = yield* decodeIngestUp(text)
      if ((yield* socket.state) === "new") {
        if (message._tag === "Token" && (yield* tokenMatches(message.token))) {
          yield* socket.setState("ready")
          relayOnline = true
          yield* market.relayOnline
          yield* scheduleDelta
          return yield* checkStatus
        }
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      relayOnline = true
      yield* market.ingest(message)
      yield* scheduleDelta
      yield* checkStatus
      if (message._tag !== "Frames") return
      yield* insert(
        message.feed === "Stockbit"
          ? yield* stockbitTrades(options.date, message.frames)
          : yield* ajaibTrades(options.date, message.frames)
      )
      yield* scheduleDelta
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "Protocol version mismatch")
      )
  )

  // The page's Select, on open and on every change: answered with a snapshot,
  // after which the socket gets deltas.
  const viewerMessage = Effect.fnUntraced(
    function* (socket: Peer, text: string) {
      const { selected } = yield* decodeViewerUp(text)
      const indicative = yield* market.indicativeOf(selected)
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        tape: tape.slice(-SNAPSHOT_TRADES),
        status: yield* market.status,
        ...(indicative === undefined ? {} : { indicative }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
      yield* checkStatus
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "New version, reload")
      )
  )

  // A ready ingest socket closed, leaving `remaining` ready ones. With none,
  // the relay is offline.
  const ingestClosed = Effect.fnUntraced(function* (remaining: number) {
    if (remaining > 0 || !relayOnline) return
    relayOnline = false
    yield* market.relayOffline
    yield* scheduleDelta
  })

  // After a ban, revoke or delete: the page on a session the account no
  // longer holds is sent to sign in.
  const endSessions = Effect.fnUntraced(function* (held: HeldSessions) {
    for (const viewer of yield* options.viewersOf(held.userId)) {
      if (!held.sessionIds.includes(viewer.sessionId))
        yield* viewer.peer.close(ViewerCloseCode.SignInRequired, "Sign in")
    }
  })

  return { ingestMessage, viewerMessage, ingestClosed, endSessions }
})
