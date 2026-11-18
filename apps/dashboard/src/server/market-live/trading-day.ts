// The trading-day Durable Object's behaviour, apart from Cloudflare (spec
// apinrdw/kumora#138, "The trading-day Durable Object" and "The viewer
// protocol"). trading-day-object.ts adapts it to the Durable Object and its
// hibernatable sockets; the tests drive it with fake sockets and TestClock.
// Time is read only through Effect's Clock.
import {
  INGEST_TOKEN_MESSAGE_LIMIT,
  IngestCloseCode,
  READING_PHASES,
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
  wibDayEnd,
  type BrokerCodesBatch,
  type DayState,
  type Feed,
  type IndicativePrice,
  type IngestUp,
  type OrderBook,
  type RecordedDay,
  type RecordedResource,
  type RunningTrade,
  type TradeNumber,
  type WibDate,
  BUBBLE_MINUTES,
  FLUSH_PAST_MINUTE,
  MINUTE_MS,
} from "@workspace/relay"
import type { WorkerEnv } from "@workspace/server"
import type { Cause, Layer } from "effect"
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
import { BROKER_TOTALS_VERSION } from "../broker-totals/version.ts"
import {
  clearBuiltDay,
  writeBuiltDay,
  type BrokerTotalsDb,
} from "../broker-totals/db.ts"
import { ajaibTrades } from "./ajaib.ts"
import { ajaibPrices } from "./ajaib-price.ts"
import { backfillTrades } from "./backfill-page.ts"
import { makeBubbleBook } from "./bubble-book.ts"
import { makeLevelLedger } from "./level-ledger.ts"
import { makeReadingsBook } from "./readings-book.ts"
import { dayValuesAnswer, makePreviousValues } from "./previous-values.ts"
import { makeBrokerCodes } from "./broker-codes.ts"
import {
  BROKER_TOTALS_DUE,
  BROKER_TOTALS_STALE,
  buildBrokerTotals,
} from "./broker-totals.ts"
import { ingestTokenMatches } from "./ingest-token.ts"
import { makeBookChunks } from "./book-chunks.ts"
import { makeCandleBook, minuteOf } from "./candles.ts"
import { makeKeptAlerts } from "./kept-alerts.ts"
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
import { makeBookEventLog } from "./book-event-log.ts"
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
import {
  SNAPSHOT_TRADES,
  bubblesAnswer,
  recordedAnswer,
} from "./recorded-answers.ts"
import { type AccountId, type HeldSessions, type SessionId } from "./routes.ts"
import { stockbitTrades } from "./stockbit.ts"
import { makeSweepBrokers } from "./sweep-brokers.ts"
import { WAKES, makeWakes, type Wake } from "./wakes.ts"
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
  "walk",
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

// The lists of a delta that hold anything: an empty one stays out.
const nonEmpty = <L extends Record<string, ReadonlyArray<unknown>>>(lists: L) =>
  Effect.sync(() => {
    const kept: Partial<L> = {}
    for (const key in lists) if (lists[key].length > 0) kept[key] = lists[key]
    return kept
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
  readonly readings: Effect.Success<ReturnType<typeof makeReadingsBook>>
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
    yield* day.readings.restore(
      book,
      (code) =>
        Effect.map(day.dayStates.stateOf(code, true), (state) => state?.last),
      Effect.fnUntraced(function* (code, at) {
        const stored = yield* day.store.chunkAt(code, yield* minuteOf(at))
        return stored === undefined
          ? undefined
          : yield* bookAt(yield* decodeBookChunk(stored), at)
      })
    )
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
// When the index rebuild first needs the alarm, for a day with no deadline
// stored: none once built.
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

// Where a day's tape comes from: see `source` in makeTradingDay.
type TapeSource = "unknown" | "relay" | "walk"

// A day's tape source as its store holds it. A day stored before the fact
// was is relay once it holds a trade.
const storedTapeSource = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const fact = yield* store.fact(Fact.tapeSource)
  if (fact === "relay" || fact === "walk") return fact
  return (yield* store.highestTrade) === undefined ? "unknown" : "relay"
})

// When the seal first needs the alarm, for a day with no deadline stored:
// its instant for a relay day, a walk day once buildable, and an unknown day
// the relay can still make relay; none once sealed.
const sealWakeAtStart = Effect.fnUntraced(function* (
  sealed: boolean,
  source: TapeSource,
  buildable: Effect.Effect<boolean>,
  sealAt: DateTime.Utc
) {
  if (sealed) return undefined
  if (source === "unknown")
    return DateTime.isLessThan(yield* DateTime.now, sealAt) ? sealAt : undefined
  if (source === "relay" || (yield* buildable)) return sealAt
  return undefined
})

// When the broker totals build first needs the alarm, for a day with no
// deadline stored: at once for a sealed day that builds and is marked due or
// never built and buildable, a quiet wait after the start for one marked
// stale.
//
// Decision: a sealed day never built, buildable at the start, is marked due
// and built at once, as `totalsWritten` does: a day sealed before its gate
// let it build (apinrdw/kumora#464) has no fact. An older version waits for
// the reconcile poke. See apinrdw/kumora#457.
const buildWakeAtStart = Effect.fnUntraced(function* (
  builds: boolean,
  fact: string | undefined,
  buildable: Effect.Effect<boolean>,
  markDue: Effect.Effect<void>
) {
  if (!builds) return undefined
  if (fact === BROKER_TOTALS_STALE)
    return DateTime.addDuration(yield* DateTime.now, REBUILD_QUIET)
  if (fact === undefined && (yield* buildable)) yield* markDue
  else if (fact !== BROKER_TOTALS_DUE) return undefined
  return yield* DateTime.now
})

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
  // Asks the named day's object for its values (previous-values.ts). Never
  // asked by default.
  readonly previousDayValues?: (
    date: WibDate
  ) => Effect.Effect<Response, unknown, WorkerEnv>
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
  const todayDate = yield* wibDateAt(yield* DateTime.now)
  const today = todayDate === options.date
  const store = yield* makeDayStore(options.sql, { today })
  let sealed = (yield* store.fact(Fact.sealed)) !== undefined
  const sealAt = yield* sealInstant(options.date)
  // Decision: a day's tape source is unknown until its first relay trade
  // before 17:00 makes it relay or a walk's first fields make it walk, kept
  // for good. A relay day seals at 17:00, a walk day once buildable from
  // 17:00, an unknown day never. Walk rows hold on a relay day and on any
  // sealed day, so a later, higher `end` leaves no sealed day short (#449).
  //
  // So a sealed day never changes, and its answers are immutable. A day an
  // older revision sealed holding no trade, as it sealed a History day, is
  // unsealed here: it wrote no index row. A History day walked before #437,
  // walk_trades rows alone, holds nothing until a walk sends its tape again.
  // See spec apinrdw/kumora#437, "A History walk day becomes a recorded day".
  let source: TapeSource = yield* storedTapeSource(store)
  if (source === "unknown" && sealed) {
    yield* store.setFact(Fact.sealed, undefined)
    sealed = false
  }
  const brokerCodes = yield* makeBrokerCodes({
    date: options.date,
    sql: options.sql,
    fact: store.fact,
    walkRowsHold: Effect.sync(() => source === "relay" || sealed),
  })
  // The one gate the build and a walk day's seal read (`buildable` in
  // broker-codes.ts).
  const buildable = Effect.map(brokerCodes.buildable, Option.isSome)
  const sweepBrokers = yield* makeSweepBrokers({
    sql: options.sql,
    store,
    brokerCodes,
  })
  const setAlarm = options.setAlarm ?? (() => Effect.void)
  let orderFlowBuilt = yield* orderFlowBuiltAtStart(store)
  // Midnight WIB after the day, in epoch ms.
  const dayEnd = DateTime.toEpochMillis(yield* wibDayEnd(options.date))
  // Decision: an object restores the live day from its store unless the day
  // is sealed and past: a past day's object answers recorded day GETs
  // straight from the store, and broker codes POSTs and status GETs from its
  // own tables (broker-codes.ts). Today's still serves viewers and its
  // bubbles answer after the seal (recorded-answers.ts, `bubblesAnswer`).
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
  const bubbles = yield* makeBubbleBook(
    restoring
      ? yield* store.storedBubbles(BUBBLE_MINUTES)
      : { days: [], minutes: [] }
  )
  const candles = yield* makeCandleBook(store, bubbles.settled)
  const keptAlerts = yield* makeKeptAlerts
  const ingests = options.ingests ?? Effect.succeed([])
  const books = yield* makeOrderBooks(options.date)
  const readings = yield* makeReadingsBook({ date: options.date })
  const previousValues = yield* makePreviousValues({
    date: options.date,
    fact: store.fact,
    setFact: store.setFact,
    fetchDay: options.previousDayValues,
  })
  const bookChunks = yield* makeBookChunks
  const ledger = yield* makeLevelLedger
  const bookEvents = yield* makeBookEventLog(store)
  // The market phase and relay gaps the ledger last read under.
  let ledgerRegime = ""
  // Whether the store holds the marker that this day records book events,
  // and whether this object read the ledger from live books.
  // Decision: only a ledger read from live books marks the day: a History
  // walk or a seal alone records no book events, so the day answers that
  // none were recorded. See spec apinrdw/kumora#517, "Book events".
  let bookEventsMarked = (yield* store.fact(Fact.bookEvents)) !== undefined
  let bookEventsRead = false
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
  // The bubbles answer as last built, served until the next build.
  let bubblesBody: string | undefined
  // The feed downs fact as the day store last took it.
  let writtenDowns = storedDowns
  // What a flush took whose write failed, apart from the trades and candles
  // the candle book keeps; the next flush writes it.
  let unwritten: Pick<Flush, "livePrices" | "chunks" | "ajaibBooks"> | undefined

  if (restoring) {
    for (const price of yield* restoreLastFrames({
      store,
      candles,
      books,
      dayStates,
      bookChunks,
      readings,
    }))
      lastLivePrices.set(price.code, price)
    yield* candles.rankStored
  }

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
    yield* ledger.trade(held, merged)
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
    yield* relayTaken
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
    yield* ledger.trade(undefined, trade)
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

  // The book events of the books that changed, read only in Sessions 1 and
  // 2 with no relay gap open.
  // Decision: book events are read only in Sessions 1 and 2, and the ledger
  // resets whenever the phase changes or a relay gap opens or closes. See
  // spec apinrdw/kumora#517, "Book events".
  const readLedger = Effect.fnUntraced(function* (
    changedBooks: ReadonlyArray<OrderBook>,
    conditions: MarketConditions
  ) {
    const open = conditions.gaps.some((gap) => gap.to === undefined)
    const regime = `${conditions.phase}|${conditions.gaps.length}|${open}`
    if (regime !== ledgerRegime) {
      ledgerRegime = regime
      yield* ledger.reset
    }
    if (open || !READING_PHASES.has(conditions.phase)) return
    for (const book of changedBooks) {
      bookEventsRead = true
      yield* bookEvents.add(yield* ledger.book(book))
    }
  })

  // A code's scanner figures, for a snapshot and a delta.
  const figuresOf = Effect.fnUntraced(function* (code: StockCode) {
    const quote = yield* dayStates.quoteOf(code, yield* stockbitLive)
    return {
      code,
      last: quote.last,
      previousClose: quote.previousClose,
      previousValue: yield* previousValues.valueOf(code),
      value: yield* bubbles.dayValue(code),
    }
  })
  const figuresKey = (figures: Effect.Success<ReturnType<typeof figuresOf>>) =>
    Effect.sync(() =>
      JSON.stringify([
        figures.last,
        figures.previousClose,
        figures.previousValue,
        figures.value,
      ])
    )
  // Each code's scanner figures every ready viewer holds, as `figuresKey`; a
  // code missing is one some viewer may hold otherwise. A snapshot that hands
  // a viewer other figures drops the code, so the next delta sends it to all.
  const sentFigures = new Map<StockCode, string>()
  // Each input has one source: last price and previous close
  // `dayStates.quoteOf`, the previous day's value `previousValues`, today's
  // value the bubbles' day sums; the readings carry only their book's.
  // Decision: every scanner input but the readings is a figure, and each
  // delta sends every code whose figures differ from `sentFigures`, compared
  // rather than tracked, so whatever books, trades and frames come in, every
  // page holds each code's current inputs after the next delta. See spec
  // apinrdw/kumora#517, "Data".
  // Every code with readings' figures, each trade past its merge window
  // settled first, so today's value counts it.
  const currentFigures = Effect.gen(function* () {
    yield* candles.settledBefore
    return yield* Effect.forEach(yield* readings.all, ({ code }) =>
      figuresOf(code)
    )
  })
  const changedFigures = Effect.gen(function* () {
    const changed: Array<Effect.Success<ReturnType<typeof figuresOf>>> = []
    for (const figures of yield* currentFigures) {
      const key = yield* figuresKey(figures)
      if (sentFigures.get(figures.code) === key) continue
      sentFigures.set(figures.code, key)
      changed.push(figures)
    }
    return changed
  })
  // Whether a delta would carry figures: a trade settling past its merge
  // window changes a code's value with no frame to schedule one.
  const figuresPending = Effect.gen(function* () {
    for (const figures of yield* currentFigures)
      if (sentFigures.get(figures.code) !== (yield* figuresKey(figures)))
        return true
    return false
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
    const changedBooks = yield* books.takeChanged(live)
    for (const book of changedBooks) yield* bookChunks.record(book)
    const states = yield* dayStates.takeChanged(live, yield* onDemand.watched)
    const conditions = yield* market.conditions
    const bookReadings = yield* readings.read(
      changedBooks,
      conditions.phase,
      (code) =>
        Effect.map(dayStates.stateOf(code, live), (state) => state?.last)
    )
    yield* readLedger(changedBooks, conditions)
    // Decision: a delta carries whole books only for codes some viewer
    // selected, as footprints do: a page reads only its selected code's, and
    // whole books were 86% of a viewer's inflated bytes. Every other changed
    // code goes out as its readings. See spec apinrdw/kumora#517, "Data".
    const orderBooks = changedBooks.filter((book) => selected.has(book.code))
    const encoded = yield* encodeConditions(conditions)
    const conditionsChanged = encoded !== sentConditions
    sentConditions = encoded
    const optional = yield* nonEmpty({
      footprints: changed.footprints,
      sweeps: changed.sweeps,
      sweepAlerts: changed.sweepAlerts,
      orderBooks,
      bookReadings,
      scannerFigures: yield* changedFigures,
      bookEvents: yield* bookEvents.takeDelta,
      dayStates: states,
      indicative: yield* market.indicativeChanges,
    })
    if (
      trades.length === 0 &&
      changed.candles.length === 0 &&
      Object.keys(optional).length === 0 &&
      !conditionsChanged
    )
      return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      at: yield* DateTime.now,
      tape: trades,
      candles: changed.candles,
      ...optional,
      ...(conditionsChanged ? { conditions } : {}),
    })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) !== "ready") continue
      if (!(yield* closedUnserved(viewer))) yield* viewer.send(text)
    }
    yield* keptAlerts.keep(changed.sweepAlerts, tape)
  })

  const scheduleDelta = Effect.gen(function* () {
    if (deltaScheduled) return
    if (
      pending.size === 0 &&
      !(yield* candles.hasChanges) &&
      !(yield* books.hasChanges(yield* stockbitLive)) &&
      !(yield* dayStates.hasChanges) &&
      !(yield* conditionsPending) &&
      !(yield* figuresPending)
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
    const events = yield* bookEvents.toFlush
    const ajaibBooks = yield* books.takeAjaibBooks
    const marking = bookEventsRead && !bookEventsMarked
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
        ...(marking ? { [Fact.bookEvents]: "recorded" } : {}),
        ...facts,
      },
      bookEvents: events,
    }
    unwritten = payload
    yield* store.write(payload)
    yield* Effect.logInfo("Rows written").pipe(
      Effect.annotateLogs({ ...(yield* store.takeMeter) })
    )
    unwritten = undefined
    if (marking) bookEventsMarked = true
    yield* bookEvents.written(events.length)
    writtenDowns = payload.facts[Fact.feedDowns]
    yield* candles.written
  })

  // Decision: the bubbles answer is built on the flush 5 s past each minute
  // and served as is until the next; a GET before the object's first build
  // builds it. Each build logs its codes and bytes for the cost check; its
  // time is measured off the Worker, whose clock stands still while it
  // computes (bubbles.test.ts). See spec apinrdw/kumora#427, "When it is built".
  //
  // Decision: a sealed day's answer is settled before the day's end: the seal
  // settled every trade and the day takes none after it, so the one build
  // after the seal settles past every snapshot of the day. See
  // apinrdw/kumora#436.
  const buildBubbles = Effect.gen(function* () {
    const built = yield* bubbles.build(
      sealed ? dayEnd : yield* candles.settledBefore,
      (code) => lastLivePrices.get(code)?.previous
    )
    bubblesBody = built.text
    yield* Effect.logInfo("Bubbles built").pipe(
      Effect.annotateLogs({ codes: built.codes, bytes: built.text.length })
    )
    return built.text
  })

  const unflushed = Effect.gen(function* () {
    return (
      unwritten !== undefined ||
      livePricesChanged.size > 0 ||
      (yield* bookEvents.toFlush).length > 0 ||
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
            yield* buildBubbles.pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Bubbles not built", cause)
              )
            )
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
  // first, and it records no relay gap: its tape is the walks' trades.
  const seal = Effect.fnUntraced(function* (now: DateTime.Utc) {
    const walked = source === "walk"
    if (walked) {
      yield* buildWalkedDay(store)
      orderFlowBuilt = true
    }
    const sealGaps = walked ? [] : (yield* market.conditions).gaps
    yield* flush(true, {
      [Fact.gaps]: yield* encodeRecordedGaps({ gaps: sealGaps }),
    })
    // Decision: a day buildable at its seal builds just after it, in the
    // seal's own wake: never under the turn while the market streams. See
    // spec apinrdw/kumora#437, "When it runs".
    const due = options.brokerTotalsDb !== undefined && (yield* buildable)
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
    // The next GET builds the bubbles answer from the seal's last candles.
    bubblesBody = undefined
    if (due) yield* wakes.set("build", now)
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* sweepBrokers.storage),
      })
    )
  })

  // A batch's rows with fields as tape trades, marked walk and their
  // sides settled as a merged trade's, on a day neither relay nor sealed;
  // the first makes an unknown day walk, in the same transaction. A day of a
  // year the schedule doesn't bake keeps the sides the walk sent: its
  // auction phases aren't known.
  const walkTapeOf = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    if (source === "relay" || sealed) return
    const trades: Array<RunningTrade> = []
    for (const [tradeNumber, , fields] of batch.rows) {
      if (fields === undefined) continue
      const trade: RunningTrade = {
        tradeNumber,
        ...fields,
        feeds: ["walk"],
      }
      trades.push(
        yield* settleSide(trade).pipe(
          Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(trade))
        )
      )
    }
    if (trades.length === 0) return
    yield* store.write({
      trades,
      candles: [],
      footprints: [],
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {
        [Fact.tapeSource]: "walk",
        ...(yield* sweepBrokers.persisting(trades)),
      },
    })
    source = "walk"
  })

  // The relay's first trade on an unknown day makes it relay, stored at
  // once: its 17:00 seal wake is armed from its start.
  const relayTaken = Effect.gen(function* () {
    if (source !== "unknown") return
    yield* store.setFact(Fact.tapeSource, "relay")
    source = "relay"
  })

  // Whether the day takes the relay's messages: a relay day until sealed,
  // an unknown one until 17:00.
  const takesIngest = Effect.gen(function* () {
    if (source === "relay") return !sealed
    return (
      source === "unknown" && DateTime.isLessThan(yield* DateTime.now, sealAt)
    )
  })

  // What the alarm is armed for since it last fired, so a later wake never
  // displaces an earlier one. The Durable Object keeps the alarm itself
  // across hibernation; the day's start arms it again from its deadlines.
  let armed: DateTime.Utc | undefined
  const arm = (at: DateTime.Utc) =>
    Effect.suspend(() => {
      if (armed !== undefined && !DateTime.isLessThan(at, armed))
        return Effect.void
      armed = at
      return setAlarm(at)
    })
  // The seal is due at 17:00 WIB, a minute after a seal that didn't land.
  // Decision: a walk day arms the seal only once buildable (`buildable`,
  // MISSING_ALLOWANCE in broker-codes.ts): until then it is never listed.
  // The batch that makes it so arms the seal at once (`walkSealDue`). See
  // spec apinrdw/kumora#437 and apinrdw/kumora#457.
  const wakes = yield* makeWakes(store, arm)
  yield* wakes.restore(
    "seal",
    sealWakeAtStart(sealed, source, buildable, sealAt)
  )
  yield* wakes.restore(
    "index",
    indexWakeAtStart(brokerCodes.indexBuilt, yield* wakes.deadline("seal"))
  )
  yield* wakes.restore(
    "build",
    buildWakeAtStart(
      sealed && options.brokerTotalsDb !== undefined,
      yield* store.fact(Fact.brokerTotals),
      buildable,
      store.markBrokerTotals(BROKER_TOTALS_DUE)
    )
  )

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
    yield* wakes.armEarliest
    // A deadline on, not at each socket's instant: a trickle of openings then
    // wakes the object once a deadline, and a silent socket lives two at most.
    if (withTime) yield* arm(DateTime.addDuration(now, INGEST_TOKEN_DEADLINE))
  })

  // An ingest socket the object accepted: its token deadline is a wake.
  const ingestOpened = Effect.gen(function* () {
    yield* arm(DateTime.addDuration(yield* DateTime.now, INGEST_TOKEN_DEADLINE))
  })

  // A duty that failed is due again a minute later.
  const retried = (wake: Wake, message: string, now: DateTime.Utc) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logError(message, cause).pipe(
        Effect.andThen(wakes.set(wake, DateTime.add(now, { minutes: 1 })))
      )
    )

  // Each due wake's duty, its precondition checked first: one that no
  // longer holds drops the wake, or moves it where it will.
  const duties: Record<
    Wake,
    (now: DateTime.Utc) => Effect.Effect<void, never, WorkerEnv>
  > = {
    // A walk day seals only once buildable; the batch that makes it so sets
    // the wake again (`walkSealDue`). An unknown day never seals.
    seal: Effect.fnUntraced(function* (now) {
      if (DateTime.isLessThan(now, sealAt))
        return yield* wakes.set("seal", sealAt)
      if (
        sealed ||
        source === "unknown" ||
        (source === "walk" && !(yield* buildable))
      )
        return yield* wakes.set("seal", undefined)
      yield* seal(now).pipe(
        Effect.andThen(wakes.set("seal", undefined)),
        retried("seal", "Day not sealed", now)
      )
    }),
    // A page a wake, and none while the market streams.
    index: Effect.fnUntraced(function* (now) {
      if (!sealed && DateTime.isLessThan(now, sealAt))
        return yield* wakes.set("index", sealAt)
      yield* brokerCodes.indexPage.pipe(
        Effect.flatMap((built) => wakes.set("index", built ? undefined : now)),
        retried("index", "Broker trades not indexed", now)
      )
    }),
    // A build that failed keeps the day's fact as it was.
    build: Effect.fnUntraced(function* (now) {
      if (!sealed || options.brokerTotalsDb === undefined)
        return yield* wakes.set("build", undefined)
      yield* buildTotals(options.brokerTotalsDb).pipe(
        Effect.andThen(wakes.set("build", undefined)),
        retried("build", "Broker totals not built", now)
      )
    }),
  }

  // Decision: the alarm, set for the seal at 17:00 WIB, never fails: a seal
  // that didn't land sets the alarm a minute later, as the runner answers a
  // failure as handled, so Cloudflare would not retry it and nothing else
  // wakes the object. Every alarm sweeps the ingest sockets first. See
  // apinrdw/kumora#157.
  const alarm = Effect.gen(function* () {
    armed = undefined
    const now = yield* DateTime.now
    for (const wake of WAKES)
      if (yield* wakes.due(wake, now)) yield* duties[wake](now)
    yield* sweepIngests
  })

  // The batch that makes a walk day buildable sets its seal for now, unless
  // one is due already. Without N the day can't be, so it isn't scanned.
  const walkSealDue = Effect.gen(function* () {
    if (sealed || source !== "walk") return
    if ((yield* store.fact(Fact.brokerCodesN)) === undefined) return
    if (!(yield* buildable)) return
    const now = yield* DateTime.now
    const set = yield* wakes.deadline("seal")
    if (set !== undefined && !DateTime.isLessThan(now, set)) return
    yield* wakes.set("seal", now)
  })

  // The day's broker totals and candles, built and written to the broker
  // totals DB, then the build version marked, its figures logged as the
  // first real day's sizes. See spec apinrdw/kumora#437, "Further Notes".
  // Decision: a day no longer buildable, as a stale one can be, loses its
  // built figures and reads as a gap, never as a day with its old sums and
  // fewer trades missing. Its fact stays, so the batch that makes it
  // buildable again rebuilds it. See apinrdw/kumora#457.
  const buildTotals = Effect.fnUntraced(function* (
    db: Layer.Layer<BrokerTotalsDb, never, WorkerEnv>
  ) {
    const missing = yield* brokerCodes.buildable
    if (Option.isNone(missing))
      return yield* clearBuiltDay(options.date).pipe(Effect.provide(db))
    const started = yield* Clock.currentTimeMillis
    const build = yield* buildBrokerTotals(brokerCodes, missing.value)
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

  // Decision: a batch that corrects a built or stale day marks it stale and
  // moves its rebuild REBUILD_QUIET past it. Else a batch that leaves a
  // sealed day buildable, no build wake set and its build not current, arms
  // one at once (an unbuilt day marked due): a wake that found the day
  // unbuildable was dropped. See spec apinrdw/kumora#437 and PR #449.
  //
  // The batch's answer never waits on the build.
  const totalsWritten = Effect.fnUntraced(function* (corrected: boolean) {
    if (!sealed || options.brokerTotalsDb === undefined) return
    const fact = yield* store.fact(Fact.brokerTotals)
    if (corrected && fact !== undefined && fact !== BROKER_TOTALS_DUE) {
      if (fact !== BROKER_TOTALS_STALE)
        yield* store.markBrokerTotals(BROKER_TOTALS_STALE)
      return yield* wakes.set(
        "build",
        DateTime.addDuration(yield* DateTime.now, REBUILD_QUIET)
      )
    }
    if (fact === String(BROKER_TOTALS_VERSION)) return
    if ((yield* wakes.deadline("build")) !== undefined) return
    if (!(yield* buildable)) return
    if (fact === undefined) yield* store.markBrokerTotals(BROKER_TOTALS_DUE)
    yield* wakes.set("build", yield* DateTime.now)
  })

  // Decision: the reconcile cron's poke builds a sealed, buildable day on the
  // alarm at once, marked due, whatever its own fact says: the cron pokes
  // only days the broker totals DB holds unbuilt or older, as a DB reset
  // leaves a day this version built. Other days it leaves alone. See spec
  // apinrdw/kumora#437, "On request".
  //
  // Whether the day will build.
  const reconcile = Effect.gen(function* () {
    if (!sealed || options.brokerTotalsDb === undefined) return false
    if (!(yield* buildable)) return false
    const fact = yield* store.fact(Fact.brokerTotals)
    if (fact !== BROKER_TOTALS_DUE && fact !== BROKER_TOTALS_STALE)
      yield* store.markBrokerTotals(BROKER_TOTALS_DUE)
    yield* wakes.set("build", yield* DateTime.now)
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
          yield* previousValues.load
          return yield* onDemand.greet(socket)
        }
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      const message = yield* decodeIngestUp(text)
      // Decision: a day past taking ingest (`takesIngest`) takes nothing
      // more, but one with no code list takes the relay's first. Its 404 was
      // never cached (`no-store`), so no immutable answer changes, and a day
      // whose list missed the seal stays searchable. A list stays fixed.
      if (!(yield* takesIngest)) {
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
      const snapshotTape = tape.slice(-SNAPSHOT_TRADES)
      const bookReadings = yield* readings.all
      const newestEvents = yield* bookEvents.newest
      const selectedEvents = yield* bookEvents.ofCode(selected)
      const scannerFigures = yield* currentFigures
      for (const figures of scannerFigures)
        if (sentFigures.get(figures.code) !== (yield* figuresKey(figures)))
          sentFigures.delete(figures.code)
      const snapshot = yield* encodeViewerDown({
        _tag: "Snapshot",
        at: yield* DateTime.now,
        selected,
        tape: snapshotTape,
        candles: yield* candles.candlesOf(selected),
        footprints: yield* candles.footprintsOf(selected),
        ...(orderBook === undefined ? {} : { orderBook }),
        ...(states.length === 0 ? {} : { dayStates: states }),
        conditions: yield* market.conditions,
        ...(indicative.length === 0 ? {} : { indicative }),
        ...(yield* nonEmpty({
          sweepAlerts: yield* keptAlerts.on(snapshotTape),
          bookEvents: newestEvents,
          selectedBookEvents: selectedEvents,
        })),
        ...(bookReadings.length === 0 ? {} : { bookReadings, scannerFigures }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
      // Decision: a snapshot arms the flush, so a viewer that came after the
      // last one, as in the break, after the close or with the relay down,
      // gets a bubbles build settled past its snapshot at the next one, the
      // only build its page waits for (bubbles.ts, `takeSettled`). See
      // apinrdw/kumora#436.
      yield* armFlush
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

  // Decision: a walk day answers bubbles as a past day does, 404, even on its
  // own date: Market Bubbles is live only, and a History walk sends no live
  // tape, so its bubble book never fills. See apinrdw/kumora#436.
  const recorded = (resource: RecordedResource) =>
    resource._tag === "Bubbles"
      ? Effect.flatMap(dayEnded, (ended) =>
          bubblesAnswer(
            ended || source === "walk",
            Effect.suspend(() =>
              bubblesBody === undefined
                ? buildBubbles
                : Effect.succeed(bubblesBody)
            )
          )
        )
      : Effect.andThen(builtFirst(resource), () =>
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
            bookEvents: Effect.fnUntraced(function* (code: StockCode) {
              return {
                recorded: today || bookEventsMarked,
                events: yield* bookEvents.ofCode(code),
              }
            }),
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
    // Every code's value, for the next trading day's object.
    dayValues: turn.withPermit(
      Effect.suspend(() =>
        dayValuesAnswer(
          sealed,
          Effect.map(store.storedBubbles(0), ({ days }) =>
            days.map(({ code, sums }) => ({ code, value: sums.value }))
          )
        )
      )
    ),
    // Decision: on a day the relay recorded, and on any sealed day, broker
    // codes touch no recorded day state (no flush, seal or index row), so its
    // answers stay byte-identical (#244). A walk day before its seal takes
    // their fields as its tape (`walkTapeOf`), and the batch that makes it
    // buildable arms its seal (`walkSealDue`). See spec apinrdw/kumora#437.
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
