// The trading-day Durable Object's behaviour, apart from Cloudflare (spec
// apinrdw/kumora#138, "The trading-day Durable Object" and "The viewer
// protocol"). trading-day-object.ts adapts it to the Durable Object and its
// hibernatable sockets; the tests drive it with fake sockets and TestClock.
// Time is read only through Effect's Clock.
import {
  INGEST_TOKEN_MESSAGE_LIMIT,
  IngestCloseCode,
  TradeNumberOrder,
  VIEWER_MESSAGE_LIMIT,
  ViewerCloseCode,
  decodeIngestUp,
  decodeBookChunk,
  decodeViewerUp,
  bookAt,
  encodeRecordedGaps,
  encodeViewerDown,
  MarketConditions,
  marketMomentAt,
  sealInstant,
  StockCode,
  tradeNumberValue,
  wibDateAt,
  type BrokerCodesBatch,
  type DayState,
  type Feed,
  type IndicativePrice,
  type IngestUp,
  type RecordedDay,
  type RecordedResource,
  type RunningTrade,
  type TradeNumber,
  type WibDate,
  MINUTE_MS,
} from "@workspace/relay"
import type { WorkerEnv } from "@workspace/server"
import type { Layer } from "effect"
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Option,
  Schema,
  Scope,
  Semaphore,
} from "effect"

import { tradePosition } from "../../lib/trade-position.ts"
import { writeBuiltDay, type BrokerTotalsDb } from "../broker-totals/db.ts"
import { ajaibTrades } from "./ajaib.ts"
import { ajaibPrices } from "./ajaib-price.ts"
import { backfillTrades } from "./backfill-page.ts"
import { makeBrokerCodes } from "./broker-codes.ts"
import {
  BROKER_TOTALS_DUE,
  BROKER_TOTALS_STALE,
  BROKER_TOTALS_VERSION,
  buildBrokerTotals,
} from "./broker-totals.ts"
import { ingestTokenMatches } from "./ingest-token.ts"
import { makeBookChunks } from "./book-chunks.ts"
import { makeCandleBook, minuteOf } from "./candles.ts"
import { newerThanHeld } from "./late-frames.ts"
import {
  memoryCodeListStore,
  storeCodeList,
  type CodeListStore,
} from "./code-list.ts"
import { changeOf, makeDayStates } from "./day-states.ts"
import { Fact, makeDayStore, type Flush, type Sql } from "./day-store.ts"
import type { DownRecord } from "./feed-health.ts"
import { makeFeedLagLog, timeTrades } from "./feed-lag.ts"
import { makeGaps } from "./gaps.ts"
import { makeMarketConditions } from "./market-conditions.ts"
import { makeOnDemand } from "./on-demand.ts"
import { makeOrderBooks } from "./order-books.ts"
import { chunkSlices, endBookOf, storedEndBook } from "./heat-rows.ts"
import {
  buildOrderFlow,
  buildWalkedDay,
  orderFlowBuiltAtStart,
} from "./order-flow-build.ts"
import { SNAPSHOT_TRADES, recordedAnswer } from "./recorded-answers.ts"
import { type AccountId, type HeldSessions, type SessionId } from "./routes.ts"
import { stockbitTrades } from "./stockbit.ts"
import { makeSweepBrokers } from "./sweep-brokers.ts"
import {
  mergedLivePrice,
  stockbitLivePrices,
  type LivePrice,
} from "./stockbit-liveprice.ts"

// A socket's progress. An ingest socket is `ready` once its token checked out;
// a viewer socket once it was sent a snapshot, and from then on gets deltas.
export type PeerState = "new" | "ready"

// One accepted websocket. Its state lives with the socket, so it survives the
// object hibernating.
export interface Peer {
  readonly send: (text: string) => Effect.Effect<void>
  readonly close: (code: number, reason: string) => Effect.Effect<void>
  // Whether the socket is still open. One that closed keeps its state until
  // its own close is handled.
  readonly open: Effect.Effect<boolean>
  readonly state: Effect.Effect<PeerState>
  readonly setState: (state: PeerState) => Effect.Effect<void>
  // A viewer's selected and watchlist codes, kept in the object's storage
  // under the socket's id (trading-day-object.ts). An ingest socket has none;
  // a viewer without them counts as none.
  readonly watching?: Effect.Effect<ReadonlyArray<StockCode>>
  readonly setWatching?: (
    codes: ReadonlyArray<StockCode>
  ) => Effect.Effect<void>
  // When a viewer's session ends, in epoch ms on the Clock, kept with the
  // socket like its state; undefined for a viewer tagged without one. An
  // ingest socket has none, and a viewer without the field never expires.
  readonly sessionEnd?: Effect.Effect<number | undefined>
  // When an ingest socket was accepted, in epoch ms on the Clock, kept with
  // the socket like its state; undefined for one tagged without it, which
  // is closed at the next alarm as one past its token deadline. A viewer
  // has none.
  readonly accepted?: Effect.Effect<number | undefined>
}

// A viewer socket and the session it was gated with; none for a socket
// tagged without one, which no held session keeps open.
export interface SessionViewer {
  readonly peer: Peer
  readonly sessionId: SessionId | undefined
}

// How often viewers get the trades that arrived since the last delta.
const DELTA_INTERVAL = "250 millis"

// How long an accepted ingest socket has to send its token (`alarm`).
const INGEST_TOKEN_DEADLINE = Duration.seconds(10)

// Decision: the tape in memory holds the newest 10,000 trades, the most the
// page keeps; a restarted object reloads them from the day store. An older
// trade is still deduped, counted in its candle and merged (the candle book
// holds it), but viewers aren't sent it. See apinrdw/kumora#157.
const TAPE_LIMIT = 10_000
// Decision: each feed remembers the last 40,000 trade numbers it timed, four
// tapes' worth. A copy falls outside the tape only after a tape of newer
// trades; connection B trails A by seconds, far inside 30,000 more of the
// feed's trades. Two sets of 40,000 short strings cost a few MB.
const TIMED_LIMIT = 4 * TAPE_LIMIT

// Decision: the day's state is written to the day store once a minute, 5 s
// past it, so each flush closes the minute's book chunks and 5 s merge
// windows; only the relay going offline (`ingestClosed`) flushes at once. A
// failed flush's payload rides the next, so a candle is never stored without
// its trades. See apinrdw/kumora#138 and apinrdw/kumora#157.
const FLUSH_PAST_MINUTE = 5_000

// IHSG's close and change on the strip, from its last `liveprice` frame.
// Decision: an index's frames carry no previous close and, so far observed,
// no change (the 2026-11-06 probe, `stockbit-ihsg-liveprice.json`), so the
// day records no IHSG change rather than one run from a price seen today,
// and the strip shows none; a frame that does carry either is used.
const ihsgOf = Effect.fnUntraced(function* (price: LivePrice | undefined) {
  if (price?.last === undefined) return {}
  const change =
    price.change === undefined
      ? yield* changeOf(price.last, price.previous)
      : { amount: price.change, percent: price.changePercent ?? 0 }
  return change === undefined
    ? {}
    : {
        ihsg: {
          close: price.last,
          change: change.amount,
          changePercent: change.percent,
        },
      }
})

const IHSG = StockCode.make("IHSG")

// One row per code from two flushes' rows, the later flush's replacing the
// earlier's.
const latestByCode = <T extends { readonly code: StockCode }>(
  earlier: ReadonlyArray<T>,
  later: ReadonlyArray<T>
) =>
  Effect.sync(() => {
    const codes = new Set(later.map((row) => row.code))
    return [...earlier.filter((row) => !codes.has(row.code)), ...later]
  })

// Decision: a viewer whose session ended is closed with 4401 when it would
// next be served, a delta or a snapshot, not by a timer, which hibernation
// would lose. An idle expired socket stays open, served nothing, until then.
// A viewer tagged without an end is closed the same way. See
// apinrdw/kumora#157.
const sessionEnded = Effect.fnUntraced(function* (viewer: Peer) {
  if (viewer.sessionEnd === undefined) return false
  const end = yield* viewer.sessionEnd
  return end === undefined || end <= (yield* Clock.currentTimeMillis)
})

const signInRequired = (viewer: Peer) =>
  viewer.close(ViewerCloseCode.SignInRequired, "Sign in")

// A merged trade lists its feeds in this order.
const FEEDS: ReadonlyArray<RunningTrade["feeds"][number]> = [
  "Stockbit",
  "Ajaib",
  "backfill",
]

// One trade as two feeds saw it (spec apinrdw/kumora#138, "Merge and
// dedupe"): Stockbit's fields win, sub-second time included; the other feed
// fills only a side Stockbit left unspecified.
const merge = (held: RunningTrade, arriving: RunningTrade) =>
  Effect.sync((): RunningTrade => {
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
  })

// Decision: the auction matches (inside pre-opening and pre-closing) and the
// negotiated board have no side, whichever feed claims one: Ajaib types about
// 99.5% of match prints SELL. Applied to the merged trade; the cash board
// (TN) keeps Stockbit's real aggressor. See spec apinrdw/kumora#138.
const settleSide = Effect.fnUntraced(function* (trade: RunningTrade) {
  if (trade.side === "none") return trade
  const { phase } = yield* marketMomentAt(trade.time)
  const sideless =
    trade.board === "NG" || phase === "pre-opening" || phase === "pre-closing"
  return sideless ? { ...trade, side: "none" as const } : trade
})

// How often the object checks whether the market conditions changed: a feed
// going stale is noticed within this.
const CONDITIONS_INTERVAL = "1 second"

const encodeConditions = Schema.encodeEffect(
  Schema.fromJsonString(MarketConditions)
)

// The last-frame cache, rebuilt from the store after a restart: each code's
// last `liveprice` frame and its last served order book. Returns the frames.
const restoreLastFrames = Effect.fnUntraced(function* (day: {
  readonly store: Effect.Success<ReturnType<typeof makeDayStore>>
  readonly candles: Effect.Success<ReturnType<typeof makeCandleBook>>
  readonly books: Effect.Success<ReturnType<typeof makeOrderBooks>>
  readonly dayStates: Effect.Success<ReturnType<typeof makeDayStates>>
  readonly bookChunks: Effect.Success<typeof makeBookChunks>
}) {
  // Decision: a restart reads back only the last-frame tables, one row per
  // code, bounded by the code list. The day's candles stay in the store: the
  // candle book reads a code's as a snapshot, the Day state fallback or a
  // trade in a past minute asks for them (candles.ts), so a full day's
  // ~400,000 rows never sit in memory.
  const prices = yield* day.store.livePrices
  yield* day.candles.restore(prices)
  for (const price of prices) {
    yield* day.books.livePrice(price)
    yield* day.dayStates.livePrice(price)
  }
  // The stored trades of every base's minute, so each code's Day state
  // fallback holds the ones after its base: one scan per distinct minute.
  const minutes = new Set<number>()
  for (const price of prices) minutes.add(yield* minuteOf(price.time))
  for (const minute of minutes)
    for (const trade of yield* day.store.tradesBetween(
      DateTime.makeUnsafe(minute - 1),
      DateTime.makeUnsafe(minute + MINUTE_MS - 1)
    ))
      yield* day.dayStates.trade(undefined, trade)
  for (const text of yield* day.store.latestChunks) {
    const chunk = yield* decodeBookChunk(text)
    const book = yield* bookAt(chunk, DateTime.makeUnsafe(8.64e15))
    if (book === undefined) continue
    yield* day.books.restore(book)
    yield* day.bookChunks.restore([book])
  }
  yield* day.books.restoreAjaib(yield* day.store.ajaibBooks)
  return prices
})

// Decision: the broker trades index rebuilds from the alarm, a page a wake,
// never inside a request. A day still to seal waits for its seal wake, so
// no page holds the turn while the market streams; any other starts now.
// Through `arm`, so it never displaces the seal's wake. See
// apinrdw/kumora#342.
//
// When the index rebuild first needs the alarm: none once built.
const indexWakeAtStart = (
  built: boolean,
  sealWake: DateTime.Utc | undefined
): Effect.Effect<DateTime.Utc | undefined> => {
  if (built) return Effect.succeed(undefined)
  return sealWake === undefined ? DateTime.now : Effect.succeed(sealWake)
}

// Decision: a batch that corrects a built day marks it stale and moves its
// rebuild to this long after the batch, so a burst of corrections costs one
// rebuild. See spec apinrdw/kumora#437, "When it runs".
const REBUILD_QUIET = Duration.minutes(5)

// When the seal first needs the alarm: its instant, none once sealed, and
// for a day that takes the walks' tape, none until it is complete.
const sealWakeAtStart = Effect.fnUntraced(function* (
  sealed: boolean,
  takesWalkTape: Effect.Effect<boolean>,
  complete: Effect.Effect<boolean>,
  sealAt: DateTime.Utc
) {
  if (sealed) return undefined
  if (!(yield* takesWalkTape) || (yield* complete)) return sealAt
  return undefined
})

// When the broker totals build first needs the alarm: at once for a sealed
// day that builds and is marked due, a quiet wait after the start for one
// marked stale; a restart finds either again in its facts.
const buildWakeAtStart = (
  builds: boolean,
  fact: string | undefined
): Effect.Effect<DateTime.Utc | undefined> => {
  if (builds && fact === BROKER_TOTALS_DUE) return DateTime.now
  if (builds && fact === BROKER_TOTALS_STALE)
    return Effect.map(DateTime.now, DateTime.addDuration(REBUILD_QUIET))
  return Effect.succeed(undefined)
}

export const makeTradingDay = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  // Every viewer socket the object holds, ready or not.
  readonly viewers: Effect.Effect<ReadonlyArray<Peer>>
  // Where the day's stock code list is kept; memory when not given.
  readonly codeList?: CodeListStore
  // The viewer sockets of one account, on any of its sessions.
  readonly viewersOf: (
    userId: AccountId
  ) => Effect.Effect<ReadonlyArray<SessionViewer>>
  // Every ingest socket the object holds, ready or not: backfill requests go
  // down the ready ones. None by default.
  readonly ingests?: Effect.Effect<ReadonlyArray<Peer>>
  // The object's SQLite database: the day store.
  readonly sql: Sql
  // Wakes the object at `at` to call `alarm`: the Durable Object's alarm.
  // Nothing wakes it by default.
  readonly setAlarm?: (at: DateTime.Utc) => Effect.Effect<void>
  // Writes the sealed day's row to the index Durable Object. Nothing by
  // default.
  readonly recordDay?: (
    day: RecordedDay
  ) => Effect.Effect<void, unknown, WorkerEnv>
  // The broker totals DB the day's build writes to. A day without one never
  // builds.
  readonly brokerTotalsDb?: Layer.Layer<BrokerTotalsDb, never, WorkerEnv>
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  // Decision: the object's callbacks and timer bodies run one at a time:
  // every guard on the day's state reads what its write then changes, and the
  // run loop yields mid-callback, so overlapping callbacks write over each
  // other. One permit, taken only where a callback or timer body enters and
  // never inside, so nothing under it waits on it. See apinrdw/kumora#159.
  const turn = yield* Semaphore.make(1)
  const codeListStore = options.codeList ?? (yield* memoryCodeListStore)
  const store = yield* makeDayStore(options.sql)
  const brokerCodes = yield* makeBrokerCodes({
    date: options.date,
    sql: options.sql,
    fact: store.fact,
  })
  const sweepBrokers = yield* makeSweepBrokers({
    sql: options.sql,
    store,
    brokerCodes,
  })
  const setAlarm = options.setAlarm ?? (() => Effect.void)
  let sealed = (yield* store.fact(Fact.sealed)) !== undefined
  let orderFlowBuilt = yield* orderFlowBuiltAtStart(store)
  const sealAt = yield* sealInstant(options.date)
  // Decision: an object restores the live day from its store unless the day
  // is sealed and past: a past day's object answers recorded day GETs
  // straight from the store, and broker codes POSTs and status GETs from its
  // own tables (broker-codes.ts). Today's still serves viewers after the
  // seal.
  const todayDate = yield* wibDateAt(yield* DateTime.now)
  const today = todayDate === options.date
  const restoring = !sealed || today
  // Decision: a viewer is served only until the object's day ends: past it,
  // the socket is closed with 1001 when it would next be served, and the page
  // reconnects through the gate to today's object. A ban, revoke or delete
  // reaches today's object alone (live-viewers.ts), so a socket served on
  // yesterday's would outlive it. See apinrdw/kumora#157.
  //
  // A WIB date is ISO, so a later one reads greater.
  const dayEnded = Effect.map(
    Effect.flatMap(DateTime.now, wibDateAt),
    (date) => date > options.date
  )
  // Closes a viewer that is no longer served, its session or the day ended,
  // and says so.
  const closedUnserved = Effect.fnUntraced(function* (viewer: Peer) {
    if (yield* sessionEnded(viewer)) {
      yield* signInRequired(viewer)
      return true
    }
    if (yield* dayEnded) {
      yield* viewer.close(ViewerCloseCode.DayEnded, "Day ended")
      return true
    }
    return false
  })
  const tape: Array<RunningTrade> = restoring
    ? [...(yield* store.newestTrades(TAPE_LIMIT))]
    : []
  // The highest number stored before this object started: a number at or
  // below it that the tape lacks may be stored already.
  const storedHighest = restoring ? yield* store.highestTrade : undefined
  const storedDowns = yield* store.fact(Fact.feedDowns)
  // Trades viewers haven't been sent since the last delta, new or changed,
  // by trade number.
  let pending = new Map<string, RunningTrade>()
  let deltaScheduled = false
  const candles = yield* makeCandleBook(store)
  const ingests = options.ingests ?? Effect.succeed([])
  const books = yield* makeOrderBooks(options.date)
  const bookChunks = yield* makeBookChunks
  const gaps = yield* makeGaps({ ingests, highest: storedHighest })
  const dayStates = yield* makeDayStates(candles)
  const onDemand = yield* makeOnDemand({ viewers: options.viewers, ingests })
  const feedLags = yield* makeFeedLagLog
  const market = yield* makeMarketConditions(
    options.date,
    restoring && storedDowns !== undefined
      ? (JSON.parse(storedDowns) as DownRecord)
      : undefined
  )
  // Each code's newest `liveprice` frame, merged over the ones before it, and
  // the codes' whose changed since the last flush.
  const lastLivePrices = new Map<StockCode, LivePrice>()
  let livePricesChanged = new Map<StockCode, LivePrice>()
  let flushScheduled = false
  // The feed downs fact as the day store last took it.
  let writtenDowns = storedDowns
  // What a flush took whose write failed, apart from the trades and candles
  // the candle book keeps; the next flush writes it.
  let unwritten: Pick<Flush, "livePrices" | "chunks" | "ajaibBooks"> | undefined

  if (restoring)
    for (const price of yield* restoreLastFrames({
      store,
      candles,
      books,
      dayStates,
      bookChunks,
    }))
      lastLivePrices.set(price.code, price)

  // The order book and Day state fall back to Ajaib while Stockbit's freshness
  // isn't live: delayed falls over as stale does.
  const stockbitLive = Effect.map(
    market.conditions,
    (conditions) => conditions.feeds.Stockbit === "live"
  )
  // The market conditions viewers were last sent, encoded.
  let sentConditions = ""
  let checking = false
  // Whether the market conditions or an indicative price changed since
  // viewers were last sent them.
  const conditionsPending = Effect.gen(function* () {
    const encoded = yield* encodeConditions(yield* market.conditions)
    return encoded !== sentConditions || (yield* market.indicativePending)
  })

  // Whether the day holds `trade` outside the tape: in the candle book, inside
  // its merge window or waiting for a flush to land, or stored. The store is asked only
  // when it could hold it: below a full tape, or at or below what it held
  // when this object started.
  const heldOutsideTape = Effect.fnUntraced(function* (
    trade: RunningTrade,
    beforeTape: boolean
  ) {
    if (yield* candles.holds(trade.tradeNumber)) return true
    const mayBeStored =
      beforeTape ||
      (storedHighest !== undefined &&
        (yield* tradeNumberValue(trade.tradeNumber)) <= storedHighest)
    return mayBeStored && (yield* store.hasTrade(trade.tradeNumber))
  })

  const inTape = Effect.fnUntraced(function* (trade: RunningTrade) {
    const at = yield* tradePosition(tape, trade.tradeNumber)
    return tape[at]?.tradeNumber === trade.tradeNumber
  })

  // A copy of a trade the day holds, merged into the tape row at `slot`, or
  // into the candle book's copy once the tape evicted it. A copy that adds
  // no feed and no side changes nothing.
  const mergeInto = Effect.fnUntraced(function* (
    held: RunningTrade,
    arriving: RunningTrade,
    slot: number | undefined
  ) {
    const merged = yield* settleSide(yield* merge(held, arriving))
    if (merged.feeds.length === held.feeds.length && merged.side === held.side)
      return
    if (slot !== undefined) {
      tape[slot] = merged
      pending.set(merged.tradeNumber, merged)
    }
    yield* candles.trade(held, merged)
    yield* dayStates.trade(held, merged)
  })

  // Merges a trade into the tape: a new trade number is inserted in its
  // place, a known one merged with what other feeds saw, on the tape or, once
  // the tape evicted it, inside its merge window. A new trade older than a
  // full tape's oldest counts in its candle but stays off the tape.
  //
  // Returns the feeds the day held it from before: none for a new trade,
  // undefined for one held only outside the tape and merge windows, whose
  // feeds aren't read back from the store.
  const insertOne = Effect.fnUntraced(function* (arriving: RunningTrade) {
    yield* gaps.seen(arriving)
    const at = yield* tradePosition(tape, arriving.tradeNumber)
    // The tape row of this number, if it holds one.
    const slot = tape[at]?.tradeNumber === arriving.tradeNumber ? at : undefined
    const held =
      slot === undefined
        ? yield* candles.openTrade(arriving.tradeNumber)
        : tape[slot]
    if (held !== undefined) {
      yield* mergeInto(held, arriving, slot)
      return held.feeds
    }
    const beforeTape = at === 0 && tape.length >= TAPE_LIMIT
    if (yield* heldOutsideTape(arriving, beforeTape)) return undefined
    const trade = yield* settleSide(arriving)
    if (!beforeTape) {
      tape.splice(at, 0, trade)
      if (tape.length > TAPE_LIMIT) tape.shift()
      pending.set(trade.tradeNumber, trade)
    }
    yield* candles.trade(undefined, trade)
    yield* dayStates.trade(undefined, trade)
    return []
  })

  const insert = Effect.fnUntraced(function* (
    trades: ReadonlyArray<RunningTrade>
  ) {
    for (const arriving of trades) yield* insertOne(arriving)
  })

  // Each feed's trade numbers it timed, newest last, at most TIMED_LIMIT.
  const timedBy: Record<Feed, Set<TradeNumber>> = {
    Stockbit: new Set(),
    Ajaib: new Set(),
  }
  // Whether `feed`'s copy of a trade is its first: a number it hasn't timed
  // before. Remembers it.
  const firstTiming = (feed: Feed, trade: RunningTrade) =>
    Effect.sync(() => {
      const timed = timedBy[feed]
      if (timed.has(trade.tradeNumber)) return false
      timed.add(trade.tradeNumber)
      if (timed.size > TIMED_LIMIT) timed.delete(timed.values().next().value!)
      return true
    })

  // A feed's running trades from one envelope, merged into the day, timed at
  // the feed's first relayed copy of each: new to the day, or held from the
  // other feed alone. Backfill pages aren't relayed and are never timed.
  // Decision: a copy held only outside the tape and merge windows is timed for
  // the arriving feed unless the feed timed that number before, its feeds
  // unread: a feed over a tape's span behind the other (Stockbit ~17 min
  // behind Ajaib) has only such copies. See apinrdw/kumora#239.
  const insertRelayed = Effect.fnUntraced(function* (
    feed: Feed,
    trades: ReadonlyArray<RunningTrade>
  ) {
    const firsts: Array<RunningTrade> = []
    for (const arriving of trades) {
      const before = yield* insertOne(arriving)
      const unheld = before === undefined || !before.includes(feed)
      if (unheld && (yield* firstTiming(feed, arriving))) firsts.push(arriving)
    }
    const lags = yield* timeTrades(feed, firsts)
    yield* feedLags.record(lags)
    yield* market.recordLags(lags)
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
    const selected = yield* onDemand.selected
    const changed = yield* candles.takeChanged(selected)
    const live = yield* stockbitLive
    const orderBooks = yield* books.takeChanged(live)
    for (const book of orderBooks) yield* bookChunks.record(book)
    const states = yield* dayStates.takeChanged(live, yield* onDemand.watched)
    const conditions = yield* market.conditions
    const encoded = yield* encodeConditions(conditions)
    const conditionsChanged = encoded !== sentConditions
    sentConditions = encoded
    const indicative = yield* market.indicativeChanges
    if (
      trades.length === 0 &&
      changed.candles.length === 0 &&
      changed.sweeps.length === 0 &&
      orderBooks.length === 0 &&
      states.length === 0 &&
      !conditionsChanged &&
      indicative.length === 0
    )
      return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      tape: trades,
      candles: changed.candles,
      ...(changed.footprints.length > 0
        ? { footprints: changed.footprints }
        : {}),
      ...(changed.sweeps.length > 0 ? { sweeps: changed.sweeps } : {}),
      ...(orderBooks.length > 0 ? { orderBooks } : {}),
      ...(states.length === 0 ? {} : { dayStates: states }),
      ...(conditionsChanged ? { conditions } : {}),
      ...(indicative.length > 0 ? { indicative } : {}),
    })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) !== "ready") continue
      if (!(yield* closedUnserved(viewer))) yield* viewer.send(text)
    }
  })

  const scheduleDelta = Effect.gen(function* () {
    if (deltaScheduled) return
    if (
      pending.size === 0 &&
      !(yield* candles.hasChanges) &&
      !(yield* books.hasChanges(yield* stockbitLive)) &&
      !(yield* dayStates.hasChanges) &&
      !(yield* conditionsPending)
    )
      return
    deltaScheduled = true
    yield* Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(turn.withPermit(sendDelta)),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope)
    )
  })

  // Decision: while a viewer is connected, the object checks the market
  // conditions every second and sends a delta when they changed, so a stale
  // feed or a phase turn reaches viewers without a frame. With no viewer it
  // stops: freshness and gaps come from frame and close instants, not these
  // checks. See apinrdw/kumora#157.
  const checkConditions: Effect.Effect<void> = Effect.suspend(() => {
    if (checking) return Effect.void
    checking = true
    const loop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Effect.sleep(CONDITIONS_INTERVAL)
      if ((yield* options.viewers).length === 0) {
        checking = false
        return
      }
      // One failed check is logged; the next still runs.
      yield* turn
        .withPermit(scheduleDelta)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Conditions not checked", cause)
          )
        )
      yield* loop
    })
    return loop.pipe(Effect.forkIn(scope), Effect.asVoid)
  })

  // Writes what the day recorded since the last flush in one transaction,
  // with what a failed flush took. The trades and candles come from the
  // book, which kept a failed flush's. At the seal every merge window and
  // open chunk closes.
  const flush = Effect.fnUntraced(function* (
    final: boolean,
    facts: Readonly<Record<string, string>> = {}
  ) {
    yield* feedLags.logEnded
    const settled = yield* candles.takeSettled(final)
    const chunks = yield* bookChunks.take(final)
    const livePrices = [...livePricesChanged.values()]
    livePricesChanged = new Map()
    const ajaibBooks = yield* books.takeAjaibBooks
    const retained = unwritten
    const payload: Flush = {
      trades: settled.trades,
      candles: settled.candles,
      footprints: settled.footprints,
      livePrices: yield* latestByCode(retained?.livePrices ?? [], livePrices),
      chunks: [...(retained?.chunks ?? []), ...chunks],
      ajaibBooks: yield* latestByCode(retained?.ajaibBooks ?? [], ajaibBooks),
      facts: {
        [Fact.feedDowns]: JSON.stringify(yield* market.record),
        ...(yield* sweepBrokers.persisting(settled.trades)),
        ...facts,
      },
    }
    unwritten = payload
    yield* store.write(payload)
    yield* Effect.logInfo("Rows written").pipe(
      Effect.annotateLogs({ ...(yield* store.takeMeter) })
    )
    unwritten = undefined
    writtenDowns = payload.facts[Fact.feedDowns]
    yield* candles.written
  })

  const unflushed = Effect.gen(function* () {
    return (
      unwritten !== undefined ||
      livePricesChanged.size > 0 ||
      (yield* candles.hasUnflushed) ||
      (yield* bookChunks.hasOpen) ||
      (yield* books.hasUnflushedAjaib) ||
      JSON.stringify(yield* market.record) !== writtenDowns
    )
  })

  // One flush a minute while anything is left to write, a failed one
  // included, or a feed lag line to log. A wake with nothing to write only
  // logs, so the lines add no transaction.
  // Decision: feed lag lines are logged on this flush, 5 s past the minute, as
  // structured Effect logs that Workers Logs keeps: no binding, metric store
  // or alert. A minute's timed trades keep the flush armed until its lines
  // are out. See apinrdw/kumora#231.
  const armFlush: Effect.Effect<void> = Effect.suspend(() => {
    if (flushScheduled || sealed) return Effect.void
    flushScheduled = true
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.sleep(
          Duration.millis(
            MINUTE_MS -
              ((((now - FLUSH_PAST_MINUTE) % MINUTE_MS) + MINUTE_MS) %
                MINUTE_MS)
          )
        )
      ),
      Effect.andThen(
        turn.withPermit(
          Effect.gen(function* () {
            flushScheduled = false
            if (sealed) return
            if (yield* unflushed)
              yield* flush(false).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Day not flushed", cause)
                )
              )
            else yield* feedLags.logEnded
          }).pipe(Effect.andThen(Effect.all([unflushed, feedLags.hasUnlogged])))
        )
      ),
      Effect.flatMap(([more, logging]) =>
        more || logging ? armFlush : Effect.void
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    )
  })

  // The seal: everything left, the day's relay gaps and the index row are
  // written, then the sealed marker; after it the day takes no ingest and
  // its answers are immutable.
  // A walked day's candles and order flow rows are built from its tape
  // first, and it records no relay gap: its tape is every trade 1..N.
  const seal = Effect.fnUntraced(function* (now: DateTime.Utc) {
    const walked = (yield* store.fact(Fact.walkTape)) !== undefined
    if (walked) {
      yield* buildWalkedDay(store)
      orderFlowBuilt = true
    }
    const sealGaps = walked ? [] : (yield* market.conditions).gaps
    yield* flush(true, {
      [Fact.gaps]: yield* encodeRecordedGaps({ gaps: sealGaps }),
    })
    // Decision: a day complete at its seal builds just after it, in the
    // seal's own wake: never under the turn while the market streams. See
    // spec apinrdw/kumora#437, "When it runs".
    const due =
      options.brokerTotalsDb !== undefined && (yield* brokerCodes.complete)
    const trades = yield* store.storedTrades
    if (trades > 0)
      yield* (options.recordDay ?? (() => Effect.void))({
        day: options.date,
        ...(yield* ihsgOf(yield* store.livePrice(IHSG))),
        trades,
        gap: sealGaps.length > 0,
      })
    yield* store.write({
      trades: [],
      candles: [],
      footprints: [],
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {
        [Fact.sealed]: DateTime.formatIso(now),
        ...(due ? { [Fact.brokerTotals]: BROKER_TOTALS_DUE } : {}),
      },
    })
    sealed = true
    if (due) buildWake = now
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* sweepBrokers.storage),
      })
    )
  })

  // Decision: a day the relay stored no trade of by its seal instant (a
  // History walk day, or one the relay missed) takes each walk batch's
  // fields as its tape, before the batch's codes. The walk-tape fact, written
  // with its first walk trades, keeps it such a day until its seal. See spec
  // apinrdw/kumora#437, "A History walk day becomes a recorded day".
  const takesWalkTape = Effect.gen(function* () {
    if ((yield* store.fact(Fact.walkTape)) !== undefined) return !sealed
    if ((yield* store.highestTrade) !== undefined) return false
    return !DateTime.isLessThan(yield* DateTime.now, sealAt)
  })

  // A batch's rows with fields as tape trades, marked backfill and their
  // sides settled as a merged trade's, on a day that takes the walks' tape.
  // A day sealed empty is unsealed first (day-store.ts, `unseal`). A day of
  // a year the schedule doesn't bake keeps the sides the walk sent: its
  // auction phases aren't known.
  const walkTapeOf = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    if (!(yield* takesWalkTape)) return
    const trades: Array<RunningTrade> = []
    for (const [tradeNumber, , fields] of batch.rows) {
      if (fields === undefined) continue
      const trade: RunningTrade = {
        tradeNumber,
        ...fields,
        feeds: ["backfill"],
      }
      trades.push(
        yield* settleSide(trade).pipe(
          Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(trade))
        )
      )
    }
    if (trades.length === 0) return
    if (sealed) {
      yield* store.unseal
      sealed = false
    }
    yield* store.write({
      trades,
      candles: [],
      footprints: [],
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {
        [Fact.walkTape]: "walks",
        ...(yield* sweepBrokers.persisting(trades)),
      },
    })
  })

  // When the seal next needs the alarm: 17:00 WIB, a minute after a seal
  // that didn't land, none once sealed.
  // Decision: a day that takes the walks' tape arms the seal only once
  // complete, every trade 1..N held: until then it is never listed. The
  // batch that completes it arms the seal at once (`walkSealDue`). See spec
  // apinrdw/kumora#437, "A History walk day becomes a recorded day".
  let sealWake = yield* sealWakeAtStart(
    sealed,
    takesWalkTape,
    brokerCodes.complete,
    sealAt
  )
  let indexWake = yield* indexWakeAtStart(brokerCodes.indexBuilt, sealWake)
  let buildWake = yield* buildWakeAtStart(
    sealed && options.brokerTotalsDb !== undefined,
    yield* store.fact(Fact.brokerTotals)
  )
  // What the alarm is armed for since it last fired, so a later wake never
  // displaces an earlier one. The Durable Object keeps the alarm itself
  // across hibernation; the day's start arms it again from what it finds.
  let armed: DateTime.Utc | undefined
  const arm = (at: DateTime.Utc) =>
    Effect.suspend(() => {
      if (armed !== undefined && !DateTime.isLessThan(at, armed))
        return Effect.void
      armed = at
      return setAlarm(at)
    })

  // Decision: the alarm closes an ingest socket still without its token with
  // 4408 once INGEST_TOKEN_DEADLINE passed since its accept instant in its
  // tags, so a tokenless client can't fill the object's 32,768 sockets. No
  // cap on silent sockets, which would let such a client lock out the relay.
  // See apinrdw/kumora#157.
  //
  // Whether a socket still has time.
  const closeOverdueIngests = Effect.fnUntraced(function* (now: number) {
    let withTime = false
    for (const socket of yield* ingests) {
      if ((yield* socket.state) !== "new") continue
      const accepted =
        socket.accepted === undefined ? undefined : yield* socket.accepted
      if (
        accepted !== undefined &&
        now < accepted + Duration.toMillis(INGEST_TOKEN_DEADLINE)
      ) {
        withTime = true
        continue
      }
      yield* socket.close(IngestCloseCode.TokenOverdue, "Token overdue")
    }
    return withTime
  })

  // Closes the ingest sockets past their token deadline and arms the alarm
  // for the next wake.
  const sweepIngests = Effect.gen(function* () {
    const now = yield* DateTime.now
    const withTime = yield* closeOverdueIngests(DateTime.toEpochMillis(now))
    if (indexWake !== undefined) yield* arm(indexWake)
    if (sealWake !== undefined) yield* arm(sealWake)
    if (buildWake !== undefined) yield* arm(buildWake)
    // A deadline on, not at each socket's instant: a trickle of openings then
    // wakes the object once a deadline, and a silent socket lives two at most.
    if (withTime) yield* arm(DateTime.addDuration(now, INGEST_TOKEN_DEADLINE))
  })

  // An ingest socket the object accepted: its token deadline is a wake.
  const ingestOpened = Effect.gen(function* () {
    yield* arm(DateTime.addDuration(yield* DateTime.now, INGEST_TOKEN_DEADLINE))
  })

  // Decision: the alarm, set for the seal at 17:00 WIB, never fails: a seal
  // that didn't land sets the alarm a minute later, as the runner answers a
  // failure as handled, so Cloudflare would not retry it and nothing else
  // wakes the object. Every alarm sweeps the ingest sockets first. See
  // apinrdw/kumora#157.
  const alarm = Effect.gen(function* () {
    armed = undefined
    const now = yield* DateTime.now
    // Only a day that armed the seal seals: a no-tape day's alarm runs for
    // its index rebuild alone.
    if (sealWake !== undefined && !sealed && !DateTime.isLessThan(now, sealAt))
      yield* seal(now).pipe(
        Effect.andThen(
          Effect.sync(() => {
            sealWake = undefined
          })
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Day not sealed", cause).pipe(
            Effect.andThen(
              Effect.sync(() => {
                sealWake = DateTime.add(now, { minutes: 1 })
              })
            )
          )
        )
      )
    // A page that failed is tried again a minute later, as a seal is.
    if (indexWake !== undefined && !DateTime.isLessThan(now, indexWake))
      yield* brokerCodes.indexPage.pipe(
        Effect.map((built) => {
          indexWake = built ? undefined : now
        }),
        Effect.catchCause((cause) =>
          Effect.logError("Broker trades not indexed", cause).pipe(
            Effect.andThen(
              Effect.sync(() => {
                indexWake = DateTime.add(now, { minutes: 1 })
              })
            )
          )
        )
      )
    if (
      buildWake !== undefined &&
      options.brokerTotalsDb !== undefined &&
      !DateTime.isLessThan(now, buildWake)
    ) {
      buildWake = undefined
      // A build that failed is tried again a minute later, as a seal is; the
      // fact stays as it was, so a restart tries it too.
      yield* buildTotals(options.brokerTotalsDb).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Broker totals not built", cause).pipe(
            Effect.andThen(
              Effect.sync(() => {
                buildWake = DateTime.add(now, { minutes: 1 })
              })
            )
          )
        )
      )
    }
    yield* sweepIngests
  })

  // The batch that completes a day taking the walks' tape arms its seal at
  // once. Without N the day can't be complete, so it isn't scanned.
  const walkSealDue = Effect.gen(function* () {
    if (sealed || sealWake !== undefined) return
    if ((yield* store.fact(Fact.walkTape)) === undefined) return
    if ((yield* store.fact(Fact.brokerCodesN)) === undefined) return
    if (!(yield* brokerCodes.complete)) return
    sealWake = yield* DateTime.now
    yield* arm(sealWake)
  })

  // The day's broker totals and candles, built and written to the broker
  // totals DB, then the build version marked, its figures logged as the
  // first real day's sizes. See spec apinrdw/kumora#437, "Further Notes".
  // A day no longer complete, as a stale one can be, keeps its old figures
  // and its fact until a batch completes it again.
  const buildTotals = Effect.fnUntraced(function* (
    db: Layer.Layer<BrokerTotalsDb, never, WorkerEnv>
  ) {
    if (!(yield* brokerCodes.complete)) return
    const started = yield* Clock.currentTimeMillis
    const build = yield* buildBrokerTotals(brokerCodes)
    const written = yield* writeBuiltDay(
      options.date,
      build,
      BROKER_TOTALS_VERSION,
      yield* DateTime.now
    ).pipe(Effect.provide(db))
    yield* store.markBrokerTotals(String(BROKER_TOTALS_VERSION))
    yield* Effect.logInfo("Broker totals built").pipe(
      Effect.annotateLogs({
        brokerTotalsRows: build.totals.length,
        brokerCandleRows: build.candles.length,
        brokerTotalsStatements: written.statements,
        brokerTotalsRowsWritten: written.rowsWritten,
        brokerTotalsMillis: (yield* Clock.currentTimeMillis) - started,
      })
    )
  })

  // Decision: the batch that makes a sealed day complete marks it due and
  // arms the alarm to build at once; its answer never waits on the build.
  // A day due already is left to its own wake; a batch that corrects a
  // built or stale day marks it stale and moves its rebuild REBUILD_QUIET
  // past the batch. See spec apinrdw/kumora#437, "When it runs".
  const totalsWritten = Effect.fnUntraced(function* (corrected: boolean) {
    if (!sealed || options.brokerTotalsDb === undefined) return
    const fact = yield* store.fact(Fact.brokerTotals)
    if (fact === undefined) {
      if (!(yield* brokerCodes.complete)) return
      yield* store.markBrokerTotals(BROKER_TOTALS_DUE)
      buildWake = yield* DateTime.now
    } else if (corrected && fact !== BROKER_TOTALS_DUE) {
      if (fact !== BROKER_TOTALS_STALE)
        yield* store.markBrokerTotals(BROKER_TOTALS_STALE)
      buildWake = DateTime.addDuration(yield* DateTime.now, REBUILD_QUIET)
    } else return
    yield* arm(buildWake)
  })

  // Decision: the reconcile cron's poke builds the day on the alarm at once
  // only when it is sealed, complete, and unbuilt, stale or built by another
  // build version; it marks an unbuilt or older one due, so a restart builds
  // it too. Any other day it leaves alone. See spec apinrdw/kumora#437, "On
  // request".
  //
  // Whether the day will build.
  const reconcile = Effect.gen(function* () {
    if (!sealed || options.brokerTotalsDb === undefined) return false
    const fact = yield* store.fact(Fact.brokerTotals)
    if (fact === String(BROKER_TOTALS_VERSION)) return false
    if (!(yield* brokerCodes.complete)) return false
    if (fact !== BROKER_TOTALS_DUE && fact !== BROKER_TOTALS_STALE)
      yield* store.markBrokerTotals(BROKER_TOTALS_DUE)
    buildWake = yield* DateTime.now
    yield* arm(buildWake)
    return true
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
      yield* insertRelayed(
        "Stockbit",
        yield* stockbitTrades(options.date, message.frames)
      )
      for (const price of yield* stockbitLivePrices(
        options.date,
        message.frames
      )) {
        yield* books.livePrice(price)
        yield* dayStates.livePrice(price)
        const held = lastLivePrices.get(price.code)
        // The store keeps each code's regular-board frame, the one a restart
        // rebuilds its Day state from: a cash or negotiated board's would
        // displace it.
        if (
          price.regularBoard &&
          (yield* newerThanHeld(price.time, held?.time))
        ) {
          const merged = yield* mergedLivePrice(held, price)
          lastLivePrices.set(price.code, merged)
          livePricesChanged.set(price.code, merged)
        }
        if (price.isIndex) yield* candles.indexPrice(price)
      }
      yield* books.stockbitFrames(message.frames)
    } else {
      yield* insertRelayed(
        "Ajaib",
        yield* ajaibTrades(options.date, message.frames)
      )
      yield* books.ajaibFrames(message.frames)
      yield* ajaibPriceFrames(message.frames)
    }
    yield* gaps.schedule
  })

  // The token a new socket's first message carries, or none.
  // Decision: a first message past INGEST_TOKEN_MESSAGE_LIMIT, or not a Token
  // of this protocol version, carries none. Only another protocol version
  // fails, closing with 4426 (envelope.ts); an escaped decode failure would
  // leave the unauthenticated socket open. See apinrdw/kumora#157.
  const firstToken = Effect.fnUntraced(function* (text: string) {
    if (text.length > INGEST_TOKEN_MESSAGE_LIMIT) return undefined
    const first = yield* decodeIngestUp(text).pipe(
      Effect.catchTag("SchemaError", () => Effect.succeed(undefined))
    )
    return first?._tag === "Token" ? first.token : undefined
  })

  // One envelope from the relay. The token comes first; a first message
  // without one, or with a wrong one, is closed with 4403.
  const ingestMessage = Effect.fnUntraced(
    function* (socket: Peer, text: string) {
      if ((yield* socket.state) === "new") {
        const token = yield* firstToken(text)
        if (token !== undefined && (yield* ingestTokenMatches(token))) {
          yield* socket.setState("ready")
          yield* market.relayOnline
          yield* scheduleDelta
          return yield* onDemand.greet(socket)
        }
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      const message = yield* decodeIngestUp(text)
      // Decision: a sealed day takes nothing more, but a day sealed with no
      // code list takes the relay's first one. Its 404 was never cached
      // (`no-store`), so no immutable answer changes, and a day whose list
      // missed the seal stays searchable. A list it holds stays fixed.
      if (sealed) {
        if (
          message._tag === "CodeList" &&
          Option.isNone(yield* codeListStore.read)
        )
          yield* storeCodeList(codeListStore, message.body)
        return
      }
      yield* market.ingest(message)
      if (message._tag === "CodeList")
        return yield* storeCodeList(codeListStore, message.body)
      // A page fills only numbers the day lacks: a held trade keeps the feeds
      // that saw it live.
      if (message._tag === "BackfillPage")
        yield* insert(
          yield* Effect.filter(
            yield* backfillTrades(options.date, message),
            Effect.fnUntraced(function* (trade) {
              if (yield* inTape(trade)) return false
              return !(yield* heldOutsideTape(trade, true))
            })
          )
        )
      if (message._tag === "Frames") yield* framesIn(message)
      yield* scheduleDelta
      yield* armFlush
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "Protocol version mismatch")
      )
  )

  // The page's Select, on open and on every change, in a message no longer
  // than VIEWER_MESSAGE_LIMIT: answered with a snapshot, after which the
  // socket gets deltas. A longer message is closed with 1011 unread. A Select
  // the object couldn't serve, its codes not kept or the on-demand set not
  // sent, closes the socket with 1011 too (the failure is still logged): the
  // page reconnects and sends its Select again, rather than sitting connected
  // with its codes off the set.
  const viewerMessage = Effect.fnUntraced(
    function* (socket: Peer, text: string) {
      if (yield* closedUnserved(socket)) return
      if (text.length > VIEWER_MESSAGE_LIMIT)
        return yield* socket.close(
          ViewerCloseCode.SelectNotServed,
          "Select too long"
        )
      const { selected, watchlist } = yield* decodeViewerUp(text)
      const live = yield* stockbitLive
      const orderBook = yield* books.bookOf(selected, live)
      // The selected code first: on-demand.ts reads it back as the selection.
      const watching = [...new Set([selected, ...watchlist])]
      const states: Array<DayState> = []
      const indicative: Array<IndicativePrice> = []
      for (const code of watching) {
        const state = yield* dayStates.stateOf(code, live)
        if (state !== undefined) states.push(state)
        const price = yield* market.indicativeOf(code)
        if (price !== undefined) indicative.push(price)
      }
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        selected,
        tape: tape.slice(-SNAPSHOT_TRADES),
        candles: yield* candles.candlesOf(selected),
        footprints: yield* candles.footprintsOf(selected),
        ...(orderBook === undefined ? {} : { orderBook }),
        ...(states.length === 0 ? {} : { dayStates: states }),
        conditions: yield* market.conditions,
        ...(indicative.length === 0 ? {} : { indicative }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
      yield* checkConditions
      if (socket.setWatching !== undefined) {
        yield* socket.setWatching(watching)
        yield* onDemand.update
      }
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "New version, reload")
      ).pipe(
        Effect.tapCause(() =>
          socket.close(ViewerCloseCode.SelectNotServed, "Select not served")
        )
      )
  )

  // An ingest socket closed.
  // Decision: the relay is offline when the closed socket was ready and no
  // other ingest socket is open and ready, read from socket state that
  // survives hibernation, not an instance flag a woken object would lack; it
  // flushes at once. Counted under the permit, so a pending token is settled.
  // See apinrdw/kumora#157 and apinrdw/kumora#161.
  //
  // The closing socket is told apart by identity: the object hands out one
  // Peer per socket. One that closed but whose own close isn't handled yet
  // still reads ready, so it must also be open to count.
  const ingestClosed = Effect.fnUntraced(function* (socket: Peer) {
    if ((yield* socket.state) !== "ready") return
    for (const other of yield* ingests)
      if (
        other !== socket &&
        (yield* other.open) &&
        (yield* other.state) === "ready"
      )
        return
    yield* market.relayOffline
    yield* scheduleDelta
    if (!sealed) yield* flush(false)
  })

  // A viewer socket closed: its codes leave the on-demand set.
  const viewerClosed = Effect.fnUntraced(function* (socket: Peer) {
    if (socket.setWatching === undefined) return
    yield* socket.setWatching([])
    yield* onDemand.update
  })

  // A recorded day GET, answered from the store (recorded-answers.ts).
  // A code's heatmap rows not stored yet: a failed flush's chunks, then the
  // ones still held, each slice ending by `through`.
  const heldHeat = Effect.fnUntraced(function* (
    code: StockCode,
    through: number
  ) {
    const unwrittenRows = (unwritten?.chunks ?? [])
      .filter((chunk) => chunk.code === code)
      .map((chunk) => ({
        minute: chunk.minute,
        slices: chunk.slices,
        endBook: storedEndBook(chunk.chunk),
      }))
    const heldRows = yield* Effect.forEach(
      yield* bookChunks.held(code),
      Effect.fnUntraced(function* (chunk) {
        return {
          minute: chunk.minute,
          slices: yield* chunkSlices(chunk, through),
          endBook: endBookOf(chunk),
        }
      })
    )
    return [...unwrittenRows, ...heldRows]
  })

  // A sealed day's order flow GET, and any day's sweep brokers GET, builds
  // the rows first if the day needs it: it never answers empty. GETs take
  // the turn, so a second GET awaits the first's build.
  // Decision: sweep brokers build before the seal too, as codes land before
  // it, so a day holding rows under an older shape never decodes them. See
  // spec apinrdw/kumora#384, "Old days".
  const builtFirst = Effect.fnUntraced(function* (resource: RecordedResource) {
    if (resource._tag === "SweepBrokers") return yield* sweepBrokers.builtFirst
    if (!sealed || orderFlowBuilt) return
    if (
      resource._tag !== "Candles" &&
      resource._tag !== "Sweeps" &&
      resource._tag !== "Heatmap"
    )
      return
    yield* buildOrderFlow(store)
    orderFlowBuilt = true
  })

  const recorded = (resource: RecordedResource) =>
    Effect.andThen(builtFirst(resource), () =>
      recordedAnswer(resource, {
        date: options.date,
        store,
        codeList: codeListStore,
        brokerCodes,
        sweepBrokers,
        sealed,
        liveGaps: Effect.map(
          market.conditions,
          (conditions) => conditions.gaps
        ),
        heldHeat,
        sweeps: candles.sweepsOf,
      })
    )

  yield* sweepIngests

  // After a ban, revoke or delete: the page on a session the account no
  // longer holds is sent to sign in.
  const endSessions = Effect.fnUntraced(function* (held: HeldSessions) {
    for (const viewer of yield* options.viewersOf(held.userId)) {
      if (
        viewer.sessionId === undefined ||
        !held.sessionIds.includes(viewer.sessionId)
      )
        yield* signInRequired(viewer.peer)
    }
  })

  return {
    ingestOpened: turn.withPermit(ingestOpened),
    ingestMessage: (socket: Peer, text: string) =>
      turn.withPermit(ingestMessage(socket, text)),
    viewerMessage: (socket: Peer, text: string) =>
      turn.withPermit(viewerMessage(socket, text)),
    viewerClosed: (socket: Peer) => turn.withPermit(viewerClosed(socket)),
    ingestClosed: (socket: Peer) => turn.withPermit(ingestClosed(socket)),
    endSessions: (held: HeldSessions) => turn.withPermit(endSessions(held)),
    recorded: (resource: RecordedResource) =>
      turn.withPermit(recorded(resource)),
    alarm: turn.withPermit(alarm),
    // Decision: broker codes touch none of a recorded day's state: their
    // own tables, no flush, no seal and no index row, so a sealed day takes
    // them and its recorded answers stay byte-identical. See spec
    // apinrdw/kumora#244, "Dashboard: TradingDay's broker codes store".
    // Only a day with no relay tape takes their fields (`walkTapeOf`).
    brokerCodes: {
      // Decision: a batch that changes codes rewrites its trades' sweep
      // brokers rows from their minutes' stored trades, in the codes' turn
      // and transaction, before its 200; one that changes none recomputes
      // nothing. See spec apinrdw/kumora#343, "When it is recomputed".
      post: (text: string) =>
        turn.withPermit(
          brokerCodes.post(text, {
            taken: walkTapeOf,
            alongside: sweepBrokers.recompute,
            // Broker totals before sweep brokers: its scan is the one
            // sweep brokers' check reads.
            written: (corrected) =>
              walkSealDue.pipe(
                Effect.andThen(totalsWritten(corrected)),
                Effect.andThen(sweepBrokers.completed)
              ),
          })
        ),
      status: (search: URLSearchParams) =>
        turn.withPermit(brokerCodes.status(search)),
      held: (tradeNumber: TradeNumber) =>
        turn.withPermit(brokerCodes.held(tradeNumber)),
    },
    brokerTotals: { reconcile: turn.withPermit(reconcile) },
  }
})
