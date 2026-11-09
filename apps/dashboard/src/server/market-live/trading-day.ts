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
  type DayState,
  type IngestUp,
  type RunningTrade,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema, Scope } from "effect"

import { ajaibTrades } from "./ajaib.ts"
import { ajaibPrices } from "./ajaib-price.ts"
import { backfillTrades } from "./backfill-page.ts"
import { makeCandleBook } from "./candles.ts"
import {
  codeListAnswer,
  memoryCodeListStore,
  storeCodeList,
  type CodeListStore,
} from "./code-list.ts"
import { makeDayStates } from "./day-states.ts"
import { makeGaps } from "./gaps.ts"
import { makeMarketStatus } from "./market-status.ts"
import { makeOnDemand } from "./on-demand.ts"
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
  // A viewer's selected and watchlist codes, kept with the socket like its
  // state. An ingest socket has none; a viewer without them counts as none.
  readonly watching?: Effect.Effect<ReadonlyArray<StockCode>>
  readonly setWatching?: (
    codes: ReadonlyArray<StockCode>
  ) => Effect.Effect<void>
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
  const ingests = options.ingests ?? Effect.succeed([])
  const books = yield* makeOrderBooks(options.date)
  const gaps = yield* makeGaps({ ingests })
  const dayStates = yield* makeDayStates
  const onDemand = yield* makeOnDemand({ viewers: options.viewers, ingests })
  const market = yield* makeMarketStatus(options.date)
  // The order book and Day state fall back to Ajaib while Stockbit isn't live.
  const stockbitLive = Effect.map(
    market.status,
    (status) => status.feeds.Stockbit === "live"
  )
  // The market status viewers were last sent, encoded.
  let sentStatus = ""
  let relayOnline = false
  let checking = false
  // Whether the market status or an indicative price changed since viewers
  // were last sent them.
  const statusPending = Effect.gen(function* () {
    const encoded = yield* encodeStatus(yield* market.status)
    return encoded !== sentStatus || (yield* market.indicativePending)
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
      yield* dayStates.trade(trade)
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
    const live = yield* stockbitLive
    const orderBooks = yield* books.takeChanged(live)
    const states = yield* dayStates.takeChanged(live, yield* onDemand.watched)
    const status = yield* market.status
    const encoded = yield* encodeStatus(status)
    const statusChanged = encoded !== sentStatus
    sentStatus = encoded
    const indicative = yield* market.indicativeChanges
    if (
      trades.length === 0 &&
      changed.length === 0 &&
      orderBooks.length === 0 &&
      states.length === 0 &&
      !statusChanged &&
      indicative.length === 0
    )
      return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      tape: trades,
      candles: changed,
      ...(orderBooks.length > 0 ? { orderBooks } : {}),
      ...(states.length === 0 ? {} : { dayStates: states }),
      ...(statusChanged ? { status } : {}),
      ...(indicative.length > 0 ? { indicative } : {}),
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
      !(yield* books.hasChanges(yield* stockbitLive)) &&
      !(yield* dayStates.hasChanges) &&
      !(yield* statusPending)
    )
      return
    deltaScheduled = true
    yield* Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(sendDelta),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope)
    )
  })

  // Decision: while a viewer is connected, the object looks at the market
  // status every second and sends a delta when it changed, so a feed going
  // stale or the phase turning reaches viewers without a frame. With no
  // viewer it stops: freshness and relay gaps are decided from the instants
  // of frames and closes, not from these checks, and a snapshot reads them
  // fresh.
  const checkStatus: Effect.Effect<void> = Effect.suspend(() => {
    if (checking) return Effect.void
    checking = true
    const loop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sleep(STATUS_INTERVAL)
      if ((yield* options.viewers).length === 0) {
        checking = false
        return
      }
      // One failed check is logged; the next still runs.
      yield* scheduleDelta.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Status not checked", cause)
        )
      )
      yield* loop
    })
    return loop.pipe(Effect.forkIn(scope), Effect.asVoid)
  })

  const tokenMatches = Effect.fnUntraced(function* (token: string) {
    const { INGEST_TOKEN } = yield* WorkerEnv
    return (yield* sha256(token)) === (yield* sha256(INGEST_TOKEN))
  })

  // Ajaib's `PRICE` frames, for the Day state fallback.
  const ajaibPriceFrames = Effect.fnUntraced(function* (
    frames: ReadonlyArray<string>
  ) {
    for (const price of yield* ajaibPrices(options.date, frames))
      yield* dayStates.ajaibPrice(price)
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
        yield* dayStates.livePrice(price)
        if (price.isIndex) yield* candles.indexPrice(price)
      }
      yield* books.stockbitFrames(message.frames)
    } else {
      yield* insert(yield* ajaibTrades(options.date, message.frames))
      yield* books.ajaibFrames(message.frames)
      yield* ajaibPriceFrames(message.frames)
    }
    yield* gaps.schedule
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
          return yield* onDemand.greet(socket)
        }
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      relayOnline = true
      yield* market.ingest(message)
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
      const { selected, watchlist } = yield* decodeViewerUp(text)
      const live = yield* stockbitLive
      const orderBook = yield* books.bookOf(selected, live)
      const watching = [...new Set([selected, ...watchlist])]
      const states: Array<DayState> = []
      for (const code of watching) {
        const state = yield* dayStates.stateOf(code, live)
        if (state !== undefined) states.push(state)
      }
      const indicative = yield* market.indicativeOf(selected)
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        tape: tape.slice(-SNAPSHOT_TRADES),
        candles: yield* candles.candlesOf(selected),
        ...(orderBook === undefined ? {} : { orderBook }),
        ...(states.length === 0 ? {} : { dayStates: states }),
        status: yield* market.status,
        ...(indicative === undefined ? {} : { indicative }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
      yield* checkStatus
      if (socket.setWatching !== undefined) {
        yield* socket.setWatching(watching)
        yield* onDemand.update
      }
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

  // A viewer socket closed: its codes leave the on-demand set.
  const viewerClosed = Effect.fnUntraced(function* (socket: Peer) {
    if (socket.setWatching === undefined) return
    yield* socket.setWatching([])
    yield* onDemand.update
  })

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

  return {
    ingestMessage,
    viewerMessage,
    viewerClosed,
    ingestClosed,
    endSessions,
    codeList,
  }
})
