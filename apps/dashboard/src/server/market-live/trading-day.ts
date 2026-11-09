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
  marketMomentAt,
  type IngestUp,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, Effect, Scope } from "effect"

import { ajaibTrades } from "./ajaib.ts"
import { backfillTrades } from "./backfill-page.ts"
import { makeCandleBook } from "./candles.ts"
import {
  codeListAnswer,
  memoryCodeListStore,
  storeCodeList,
  type CodeListStore,
} from "./code-list.ts"
import { makeGaps } from "./gaps.ts"
import { makeOrderBooks } from "./order-books.ts"
import type { HeldSessions } from "./routes.ts"
import { stockbitTrades } from "./stockbit.ts"
import { stockbitLivePrices } from "./stockbit-liveprice.ts"

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

// Decision: until feed freshness lands (apinrdw/kumora#149), the order book
// counts Stockbit live while it sent a frame or a ping reply in the last 15 s
// and hasn't reported its sockets closed. Once the market status decides
// Stockbit's freshness, the book reads that instead.
const STOCKBIT_STALE_AFTER = 15_000

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toString()))

export const makeTradingDay = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  // Every viewer socket the object holds, ready or not.
  readonly viewers: Effect.Effect<ReadonlyArray<Peer>>
  // Where the day's stock code list is kept; memory when not given.
  readonly codeList?: CodeListStore
  // The viewer sockets of one account, on any of its sessions.
  readonly viewersOf: (
    userId: string
  ) => Effect.Effect<ReadonlyArray<SessionViewer>>
  // Every ingest socket the object holds, ready or not: backfill requests go
  // down the ready ones. None by default.
  readonly ingests?: Effect.Effect<ReadonlyArray<Peer>>
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  const codeListStore = options.codeList ?? (yield* memoryCodeListStore)
  const tape: Array<RunningTrade> = []
  // Trades viewers haven't been sent since the last delta, new or changed,
  // by trade number.
  let pending = new Map<string, RunningTrade>()
  let deltaScheduled = false
  const candles = yield* makeCandleBook
  const books = yield* makeOrderBooks(options.date)
  let stockbitSeen = Number.NEGATIVE_INFINITY
  const stockbitLive = Effect.map(
    Clock.currentTimeMillis,
    (now) => now - stockbitSeen < STOCKBIT_STALE_AFTER
  )
  const gaps = yield* makeGaps({
    ingests: options.ingests ?? Effect.succeed([]),
  })

  // Merges each trade into the tape: a new trade number is inserted in its
  // place, a known one merged with what other feeds saw. A trade older than a
  // full tape's oldest is dropped: it can't be told from one already evicted.
  const insert = Effect.fnUntraced(function* (
    trades: ReadonlyArray<RunningTrade>
  ) {
    for (const arriving of trades) {
      yield* gaps.seen(arriving)
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
        yield* candles.trade(held, merged)
        continue
      }
      if (at === 0 && tape.length >= TAPE_LIMIT) continue
      const trade = yield* settleSide(arriving)
      tape.splice(at, 0, trade)
      if (tape.length > TAPE_LIMIT) tape.shift()
      pending.set(trade.tradeNumber, trade)
      yield* candles.trade(undefined, trade)
    }
  })

  // Decision: a delta carries every candle that changed, of any code, not
  // just each viewer's selected code's: one encoded text serves every viewer
  // and no socket keeps its selection. The page keeps its own code's.
  const sendDelta = Effect.gen(function* () {
    deltaScheduled = false
    const trades = [...pending.values()].sort((a, b) =>
      TradeNumberOrder(a.tradeNumber, b.tradeNumber)
    )
    pending = new Map()
    const changed = yield* candles.takeChanged
    const orderBooks = yield* books.takeChanged(yield* stockbitLive)
    if (trades.length === 0 && changed.length === 0 && orderBooks.length === 0)
      return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      tape: trades,
      candles: changed,
      ...(orderBooks.length > 0 ? { orderBooks } : {}),
    })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) === "ready") yield* viewer.send(text)
    }
  })

  const scheduleDelta = Effect.gen(function* () {
    if (deltaScheduled) return
    if (
      pending.size === 0 &&
      !(yield* candles.hasChanges) &&
      !(yield* books.hasChanges(yield* stockbitLive))
    )
      return
    deltaScheduled = true
    yield* Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(sendDelta),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope)
    )
  })

  const tokenMatches = Effect.fnUntraced(function* (token: string) {
    const { INGEST_TOKEN } = yield* WorkerEnv
    return (yield* sha256(token)) === (yield* sha256(INGEST_TOKEN))
  })

  // Stockbit's last sign of life, for the order book's fallback.
  const noteStockbit = Effect.fnUntraced(function* (message: IngestUp) {
    if (message._tag !== "Frames" && message._tag !== "FeedStatus") return
    if (message.feed !== "Stockbit") return
    stockbitSeen =
      message._tag === "FeedStatus" && message.status === "closed"
        ? Number.NEGATIVE_INFINITY
        : yield* Clock.currentTimeMillis
  })

  const framesIn = Effect.fnUntraced(function* (
    message: Extract<IngestUp, { readonly _tag: "Frames" }>
  ) {
    if (message.feed === "Stockbit") {
      yield* insert(yield* stockbitTrades(options.date, message.frames))
      for (const price of yield* stockbitLivePrices(
        options.date,
        message.frames
      )) {
        yield* books.livePrice(price)
        if (price.isIndex) yield* candles.indexPrice(price)
      }
      yield* books.stockbitFrames(message.frames)
    } else {
      yield* insert(yield* ajaibTrades(options.date, message.frames))
      yield* books.ajaibFrames(message.frames)
    }
    yield* gaps.schedule
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
      if (message._tag === "CodeList")
        return yield* storeCodeList(codeListStore, message.body)
      // A page fills only numbers the tape lacks: a held trade keeps the
      // feeds that saw it live.
      if (message._tag === "BackfillPage")
        yield* insert(
          (yield* backfillTrades(options.date, message)).filter(
            (trade) =>
              tape[positionOf(tape, trade)]?.tradeNumber !== trade.tradeNumber
          )
        )
      yield* noteStockbit(message)
      if (message._tag === "Frames") yield* framesIn(message)
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
      const orderBook = yield* books.bookOf(selected, yield* stockbitLive)
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        tape: tape.slice(-SNAPSHOT_TRADES),
        candles: yield* candles.candlesOf(selected),
        ...(orderBook === undefined ? {} : { orderBook }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "New version, reload")
      )
  )

  // The GET for the day's stock code list.
  const codeList = codeListAnswer(codeListStore, options.date)

  // After a ban, revoke or delete: the page on a session the account no
  // longer holds is sent to sign in.
  const endSessions = Effect.fnUntraced(function* (held: HeldSessions) {
    for (const viewer of yield* options.viewersOf(held.userId)) {
      if (!held.sessionIds.includes(viewer.sessionId))
        yield* viewer.peer.close(ViewerCloseCode.SignInRequired, "Sign in")
    }
  })

  return { ingestMessage, viewerMessage, endSessions, codeList }
})
