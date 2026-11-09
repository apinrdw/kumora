// The trading-day Durable Object's behaviour, apart from Cloudflare (spec
// apinrdw/kumora#138, "The trading-day Durable Object" and "The viewer
// protocol"). trading-day-object.ts adapts it to the Durable Object and its
// hibernatable sockets; the tests drive it with fake sockets and TestClock.
// Time is read only through Effect's Clock.
import {
  IngestCloseCode,
  TradeNumberOrder,
  decodeIngestUp,
  decodeViewerUp,
  encodeViewerDown,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Scope } from "effect"

import { ajaibTrades } from "./ajaib.ts"

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

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toString()))

export const makeTradingDay = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  // Every viewer socket the object holds, ready or not.
  readonly viewers: Effect.Effect<ReadonlyArray<Peer>>
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  const tape: Array<RunningTrade> = []
  let pending: Array<RunningTrade> = []
  let deltaScheduled = false

  // Inserts each trade not yet on the tape. A trade older than a full tape's
  // oldest is dropped: it can't be told from one already evicted.
  const insert = (trades: ReadonlyArray<RunningTrade>) => {
    for (const trade of trades) {
      const at = positionOf(tape, trade)
      if (tape[at]?.tradeNumber === trade.tradeNumber) continue
      if (at === 0 && tape.length >= TAPE_LIMIT) continue
      tape.splice(at, 0, trade)
      if (tape.length > TAPE_LIMIT) tape.shift()
      pending.push(trade)
    }
  }

  const sendDelta = Effect.gen(function* () {
    deltaScheduled = false
    const trades = pending.sort((a, b) =>
      TradeNumberOrder(a.tradeNumber, b.tradeNumber)
    )
    pending = []
    if (trades.length === 0) return
    const text = yield* encodeViewerDown({ _tag: "Delta", tape: trades })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) === "ready") yield* viewer.send(text)
    }
  })

  const scheduleDelta = Effect.suspend(() => {
    if (deltaScheduled || pending.length === 0) return Effect.void
    deltaScheduled = true
    return Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(sendDelta),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
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
        if (message._tag === "Token" && (yield* tokenMatches(message.token)))
          return yield* socket.setState("ready")
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      if (message._tag === "Frames" && message.feed === "Ajaib") {
        insert(yield* ajaibTrades(options.date, message.frames))
        yield* scheduleDelta
      }
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
      yield* decodeViewerUp(text)
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        tape: tape.slice(-SNAPSHOT_TRADES),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "New version, reload")
      )
  )

  return { ingestMessage, viewerMessage }
})
