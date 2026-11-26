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
  keptStandouts,
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
  type OrderFlowEvent,
  type OrderBook,
  type RecordedDay,
  type RecordedResource,
  type RunningTrade,
  type StandoutSweep,
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
  Scheduler,
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
import { makeOrderFlow, type StoredMinute } from "./order-flow.ts"
import { makeOrderFlowEventLog } from "./order-flow-event-log.ts"
import { makeReadingsBook } from "./readings-book.ts"
import { dayValuesAnswer, makePreviousValues } from "./previous-values.ts"
import {
  makeBrokerCodes,
  summarizeTape,
  summarizeAddedTrades,
} from "./broker-codes.ts"
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
  listedCodes,
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
import { makeRecordedBooks } from "./recorded-books.ts"
import { makeSessionBooks } from "./session-books.ts"
import { chunkSlices, endBookOf, heldChunkOf } from "./heat-rows.ts"
import {
  buildOrderFlow,
  buildWalkedDay,
  orderFlowBuiltAtStart,
} from "./order-flow-build.ts"
import type { DayBucket } from "./cold-bucket.ts"
import {
  MoveProgress,
  coldDay,
  moveStep,
  takenUnwritten,
  type ColdDay,
  type DayToMove,
} from "./cold-days.ts"
import { leavingAt, outsideStreaming, pastWindow } from "./cold-window.ts"
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

// Decision: the tape in memory holds the newest 10,000 trades, as the page does
// (apps/dashboard/docs/adr/0107-the-live-tape-holds-the-newest-10-000-trades.md)
const TAPE_LIMIT = 10_000
// Each feed remembers the last 40,000 trade numbers it timed, four
// tapes' worth. A copy falls outside the tape only after a tape of newer
// trades; connection B trails A by seconds, far inside 30,000 more of the
// feed's trades. Two sets of 40,000 short strings cost a few MB.
const TIMED_LIMIT = 4 * TAPE_LIMIT

// IHSG's close and change on the strip, from its last `liveprice` frame.
// An index's frames carry no previous close and, so far observed,
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

// An instant after any trade a day holds: a tape cursor there reads by
// trade number alone, as the move walks the tape back (cold-tape.ts).
const AFTER_EVERY_TRADE = DateTime.makeUnsafe(8_640_000_000_000_000)

// A move's progress as its fact holds it; the day wrote every one it reads.
const MoveJson = Schema.fromJsonString(MoveProgress)
const encodeMove = (progress: MoveProgress) =>
  Effect.orDie(Schema.encodeEffect(MoveJson)(progress))
const decodeMove = (text: string) =>
  Effect.orDie(Schema.decodeUnknownEffect(MoveJson)(text))

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

// Decision: the gate runs once; the object closes with 4401 at the session's end
// (apps/dashboard/docs/adr/0041-a-viewer-closes-with-4401-once-its-session-ends.md)
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

// Decision: auction matches and the negotiated board record no trade side
// (apps/dashboard/docs/adr/0108-auction-matches-and-the-negotiated-board-carry-no-side.md)
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

// Each code's last book served in a session, as the store kept it.
const storedSessionEnds = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const ended = new Map<StockCode, OrderBook>()
  for (const text of yield* store.sessionBooks) {
    const start = (yield* decodeBookChunk(text)).start
    if (start !== undefined) ended.set(start.code, start)
  }
  return ended
})

// Keeps `book` as its code's latest in `latest` unless one held is newer.
const keepLatest = (latest: Map<StockCode, OrderBook>, book: OrderBook) =>
  Effect.sync(() => {
    const held = latest.get(book.code)
    if (held === undefined || !DateTime.isLessThan(book.at, held.at))
      latest.set(book.code, book)
  })

// Each code's served book, rebuilt after a restart, and its readings.
// Decision: each session's end stores one book row per code served in it
// (apps/dashboard/docs/adr/0084-each-session-s-end-stores-one-book-row-per-code.md)
const restoreBooks = Effect.fnUntraced(function* (day: {
  readonly store: Effect.Success<ReturnType<typeof makeDayStore>>
  readonly books: Effect.Success<ReturnType<typeof makeOrderBooks>>
  readonly bookChunks: Effect.Success<typeof makeBookChunks>
  readonly readings: Effect.Success<ReturnType<typeof makeReadingsBook>>
}) {
  // The book as of the last session's end, then the newer recorded chunk's:
  // a day recorded before the session books restores from its chunks alone.
  const sessionEnds = yield* storedSessionEnds(day.store)
  const latest = new Map(sessionEnds)
  for (const text of yield* day.store.latestChunks) {
    const chunk = yield* decodeBookChunk(text)
    const book = yield* bookAt(chunk, DateTime.makeUnsafe(8.64e15))
    if (book !== undefined) yield* keepLatest(latest, book)
  }
  for (const book of latest.values()) yield* day.books.restore(book)
  yield* day.bookChunks.restore([...latest.values()])
  const ajaib = yield* day.store.ajaibBooks
  yield* day.books.restoreAjaib(ajaib)
  for (const { code } of ajaib) {
    const book = yield* day.books.bookOf(code, false)
    if (book?._tag === "OrderBook" && book.provenance === "Ajaib")
      yield* keepLatest(latest, book)
  }
  // The book in force at `at`: its recorded chunk's, or else the last
  // session end's, when that was served by then.
  const bookOfAt = Effect.fnUntraced(function* (
    code: StockCode,
    at: DateTime.Utc
  ) {
    const stored = yield* day.store.chunkAt(code, yield* minuteOf(at))
    if (stored !== undefined)
      return yield* bookAt(yield* decodeBookChunk(stored), at)
    const ended = sessionEnds.get(code)
    return ended !== undefined && DateTime.isLessThanOrEqualTo(ended.at, at)
      ? ended
      : undefined
  })
  for (const book of latest.values())
    yield* day.readings.restore(book, bookOfAt)
})

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
  // Decision: a restart reads only last-frame tables; at most 32 MiB on the heap
  // (apps/dashboard/docs/adr/0109-a-restarted-day-keeps-a-bounded-share-of-the-day-in-memory.md)
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
  yield* restoreBooks(day)
  return prices
})

// One code's stored minutes, as an order flow restart reads them: each
// candle's range and close with its footprint's cells.
const storedMinutesOf = (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) =>
  Effect.fnUntraced(function* (code: StockCode) {
    const cells = new Map(
      (yield* store.storedFootprintsOf(code)).map(
        (footprint) => [footprint.minute, footprint.cells] as const
      )
    )
    return (yield* store.storedRangesOf(code)).map(
      ({ minute, figures }): StoredMinute => ({
        minute,
        figures,
        cells: cells.get(minute),
      })
    )
  })

// An order flow event's key in the day store: at most one a code, minute,
// kind and side.
const orderFlowEventKey = (event: OrderFlowEvent) =>
  Effect.succeed(
    `${event.code}|${DateTime.toEpochMillis(event.at)}|${event.kind}|${event.side}`
  )

// A batch that corrects a built day marks it stale and moves its
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
// A sealed day never built, buildable at the start, is marked due
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
  // Where the day moves once its walk is done (cold-days.ts). A day without
  // it never moves.
  readonly cold?: {
    // Read in each step of the move and each answer once emptied, from the
    // request it runs in.
    readonly bucket: Effect.Effect<DayBucket, never, WorkerEnv>
    // Marks the day cold in the day index.
    readonly markCold: Effect.Effect<void, unknown, WorkerEnv>
    // Empties the object for good, keeping only a mark that it is cold
    // (trading-day-object.ts).
    readonly empty: Effect.Effect<void, unknown>
    // Whether the day index lists `date`: a day that was recorded.
    readonly listed: (
      date: WibDate
    ) => Effect.Effect<boolean, unknown, WorkerEnv>
    // Asks another day's object to move, if it is due.
    readonly askMove: (
      date: WibDate
    ) => Effect.Effect<unknown, unknown, WorkerEnv>
    // Moves run in Streaming hours too: the Test stage's, whose market clock
    // reads session 1 (apps/e2e/support/clock.ts).
    readonly anyHour?: Effect.Effect<boolean, never, WorkerEnv>
  }
  // Asks the named day's object for its values (previous-values.ts). Never
  // asked by default.
  readonly previousDayValues?: (
    date: WibDate
  ) => Effect.Effect<Response, unknown, WorkerEnv>
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  // Decision: the object's callbacks and timer bodies run one at a time
  // (apps/dashboard/docs/adr/0110-the-trading-day-runs-callbacks-one-at-a-time.md)
  const turn = yield* Semaphore.make(1)
  const codeListStore = options.codeList ?? (yield* memoryCodeListStore)
  // The codes the stored list names, read on the first Select after it
  // changed; none while the day holds no list.
  let listed: ReadonlySet<StockCode> | undefined
  const storeList = Effect.fnUntraced(function* (body: string) {
    yield* storeCodeList(codeListStore, body)
    listed = undefined
  })
  const todayDate = yield* wibDateAt(yield* DateTime.now)
  const today = todayDate === options.date
  const store = yield* makeDayStore(options.sql, { today })
  let sealed = (yield* store.fact(Fact.sealed)) !== undefined
  const sealAt = yield* sealInstant(options.date)
  // Decision: a day's tape source is relay or walk, set once and kept for good
  // (apps/dashboard/docs/adr/0111-a-day-s-tape-source-is-set-once.md)
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
    sealed: Effect.sync(() => sealed),
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
  // Decision: a viewer is served only until the object's day ends, then 1001
  // (apps/dashboard/docs/adr/0112-a-viewer-is-served-only-until-the-object-s-day-ends.md)
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
  const tape: Array<RunningTrade> = []
  // The highest number stored before this object started: a number at or
  // below it that the tape lacks may be stored already.
  let storedHighest: Effect.Success<typeof store.highestTrade>
  const storedDowns = yield* store.fact(Fact.feedDowns)
  // Trades viewers haven't been sent since the last delta, new or changed,
  // by trade number.
  let pending = new Map<string, RunningTrade>()
  let deltaScheduled = false
  const bubbles = yield* makeBubbleBook
  const orderFlow = yield* makeOrderFlow(options.date)
  const orderFlowEvents = yield* makeOrderFlowEventLog(store)
  // Whether the store holds the marker that this day records order flow
  // events, and whether this object judged a minute.
  // Decision: a day without a live reading answers its events not recorded
  // (apps/dashboard/docs/adr/0094-only-a-live-reading-marks-a-day-s-events-recorded.md)
  let orderFlowMarked = (yield* store.fact(Fact.orderFlowEvents)) !== undefined
  let orderFlowJudged = false
  const candles = yield* makeCandleBook(
    store,
    (code, minute, candle, print) => {
      bubbles.settled(code, minute, candle, print)
      orderFlow.settled(code, minute, print)
    }
  )
  const keptAlerts = yield* makeKeptAlerts
  // Decision: sweep alerts live only in object memory; the page keeps its marks
  // (apps/dashboard/docs/adr/0087-sweep-alerts-live-only-in-the-object-s-memory.md)
  //
  // The day's standout sweeps for a snapshot, newest first, capped per level
  // by `keptStandouts`: a restarted object starts it empty.
  let standouts: ReadonlyArray<StandoutSweep> = []
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
  const recordedBooks = yield* makeRecordedBooks(store)
  const sessionBooks = yield* makeSessionBooks
  const ledger = yield* makeLevelLedger
  const bookEvents = yield* makeBookEventLog(store)
  // The market phase and relay gaps the ledger last read under.
  let ledgerRegime = ""
  // Whether the store holds the marker that this day records book events,
  // and whether this object read the ledger from live books.
  // Decision: a day without a live reading answers its events not recorded
  // (apps/dashboard/docs/adr/0094-only-a-live-reading-marks-a-day-s-events-recorded.md)
  let bookEventsMarked = (yield* store.fact(Fact.bookEvents)) !== undefined
  let bookEventsRead = false
  const gaps = yield* makeGaps({ ingests })
  const dayStates = yield* makeDayStates(candles)
  const onDemand = yield* makeOnDemand({ viewers: options.viewers, ingests })
  const feedLags = yield* makeFeedLagLog
  const market = yield* makeMarketConditions(options.date)
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
  let unwritten:
    | Pick<Flush, "livePrices" | "chunks" | "sessionBooks" | "ajaibBooks">
    | undefined

  // The feeds' down stretches read back from the store, before the relay's
  // token or close changes them.
  const liveDowns = yield* Effect.cached(
    Effect.suspend(() =>
      storedDowns === undefined
        ? Effect.void
        : market.restore(JSON.parse(storedDowns) as DownRecord)
    )
  )
  // Each code's order flow state rebuilt from its stored minutes, and the
  // events found again that no flush stored (order-flow.ts, `restore`),
  // checked against that code's stored events alone.
  // The replay never yields to Effect's scheduler. A fiber yields
  // every 2,048 operations and waits on a timer, about 1 ms in workerd, and
  // what needs the live day waits for it. Measured 2026-11-23 on the dev
  // machine, the busy day in workerd (row-budgets.workerd.test.ts): 8,561
  // yields waited 9.1 s of the replay's 12.2 s. See PR #633.
  const restoreOrderFlow = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    if (yield* orderFlow.due(now)) orderFlowJudged = true
    yield* orderFlow.restore(
      yield* store.dayCodes,
      storedMinutesOf(store),
      now,
      (yield* market.conditions).gaps,
      Effect.fnUntraced(function* (found) {
        const stored = new Set(
          yield* Effect.forEach(
            yield* store.orderFlowEventsOf(found[0]!.code),
            orderFlowEventKey
          )
        )
        yield* orderFlowEvents.restore(
          yield* Effect.filter(found, (event) =>
            Effect.map(orderFlowEventKey(event), (key) => !stored.has(key))
          )
        )
      }),
      store.orderFlowEventsFrom
    )
  }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
  // The live day read back from the store: the tape, the bubble book, the
  // feeds' down stretches and the last frames.
  const restoreLive = Effect.gen(function* () {
    tape.push(...(yield* store.newestTrades(TAPE_LIMIT)))
    storedHighest = yield* store.highestTrade
    yield* gaps.restore(storedHighest)
    yield* bubbles.restore(yield* store.storedBubbles(BUBBLE_MINUTES))
    yield* liveDowns
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
    yield* restoreOrderFlow
  })
  // A day not sealed restores the live day at its start, a sealed
  // past day never. Today's sealed day restores it once, when a viewer's
  // Select or the bubbles answer first needs it: its object wakes for every
  // broker codes recheck until midnight, and a busy day's restore read
  // 1.4–2.9 M rows. See apinrdw/kumora#589.
  //
  // Recorded day GETs and broker codes read the store (recorded-answers.ts,
  // broker-codes.ts); the relay's token and close need only the downs. The
  // restore is never interrupted halfway, and run once: a failed one fails
  // each callback that needs it until the object is evicted, as a half-done
  // one run again would count its trades twice.
  const liveDay =
    sealed && !today
      ? Effect.void
      : yield* Effect.cached(Effect.uninterruptible(restoreLive))
  if (!sealed) yield* liveDay

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
  // A copy held only outside the tape and merge windows is timed for
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
  // Decision: book events are read only in Sessions 1 and 2
  // (apps/dashboard/docs/adr/0113-book-events-are-read-only-in-sessions-1-and-2.md)
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
    const prices = yield* dayStates.pricesOf(code, yield* stockbitLive)
    return {
      code,
      last: prices.last,
      previousClose: prices.previousClose,
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
  // Every code with readings' figures, each trade past its merge window
  // settled first, so today's value counts it.
  const currentFigures = Effect.gen(function* () {
    yield* candles.settledBefore
    return yield* Effect.forEach(yield* readings.all, ({ code }) =>
      figuresOf(code)
    )
  })
  // Each input has one source: last price and previous close
  // `dayStates.pricesOf`, the previous day's value `previousValues`, today's
  // value the bubbles' day sums; the readings carry only their book's.
  // Decision: each delta sends every code whose figures differ from those sent
  // (apps/dashboard/docs/adr/0114-each-delta-sends-every-code-whose-figures-differ.md)
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

  // Decision: a delta carries every changed candle, of any code, to every viewer
  // (apps/dashboard/docs/adr/0115-a-delta-carries-every-changed-candle-of-any-code.md)
  const sendDelta = Effect.gen(function* () {
    deltaScheduled = false
    const trades = [...pending.values()].sort((a, b) =>
      TradeNumberOrder(a.tradeNumber, b.tradeNumber)
    )
    pending = new Map()
    const selected = yield* onDemand.selected
    const changed = yield* candles.takeChanged(selected)
    // Kept before they are sent: a snapshot between the two then carries
    // them, and the page joins the delta's copy once.
    standouts = yield* keptStandouts(standouts, changed.standoutSweeps)
    const live = yield* stockbitLive
    const changedBooks = yield* books.takeChanged(live)
    for (const book of changedBooks)
      yield* bookChunks.record(book, yield* recordedBooks.has(book.code))
    const states = yield* dayStates.takeChanged(live, yield* onDemand.watched)
    const conditions = yield* market.conditions
    const bookReadings = yield* readings.read(changedBooks, conditions.phase)
    yield* sessionBooks.served(changedBooks, conditions.phase)
    yield* readLedger(changedBooks, conditions)
    // Order flow rules judge each minute in the delta tick once
    // its candle settled, 5 s past its close as the flush waits, never inside
    // the flush. See spec apinrdw/kumora#605, "Order flow events: the rules".
    yield* candles.settledBefore
    const judgedAt = yield* Clock.currentTimeMillis
    if (yield* orderFlow.due(judgedAt)) orderFlowJudged = true
    yield* orderFlowEvents.add(
      yield* orderFlow.judge(judgedAt, conditions.gaps)
    )
    // Decision: a delta carries whole books only for codes some viewer selected
    // (apps/dashboard/docs/adr/0116-a-delta-carries-whole-books-only-for-selected-codes.md)
    const orderBooks = changedBooks.filter((book) => selected.has(book.code))
    const encoded = yield* encodeConditions(conditions)
    const conditionsChanged = encoded !== sentConditions
    sentConditions = encoded
    const optional = yield* nonEmpty({
      footprints: changed.footprints,
      sweeps: changed.sweeps,
      sweepAlerts: changed.sweepAlerts,
      standoutSweeps: changed.standoutSweeps,
      orderBooks,
      bookReadings,
      scannerFigures: yield* changedFigures,
      bookEvents: yield* bookEvents.takeDelta,
      orderFlowEvents: yield* orderFlowEvents.takeDelta,
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
      !(yield* figuresPending) &&
      !(yield* orderFlow.due(yield* Clock.currentTimeMillis))
    )
      return
    deltaScheduled = true
    yield* Effect.sleep(DELTA_INTERVAL).pipe(
      Effect.andThen(turn.withPermit(sendDelta)),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope)
    )
  })

  // While a viewer is connected, the object checks the market
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
    const endedSession = yield* sessionBooks.take(
      (yield* market.conditions).phase,
      final
    )
    const livePrices = [...livePricesChanged.values()]
    livePricesChanged = new Map()
    const events = yield* bookEvents.toFlush
    const ajaibBooks = yield* books.takeAjaibBooks
    const recordedCodes = yield* recordedBooks.unwritten
    const marking = bookEventsRead && !bookEventsMarked
    const flowing = yield* orderFlowEvents.toFlush
    const markingFlow = orderFlowJudged && !orderFlowMarked
    const retained = unwritten
    const payload: Flush = {
      trades: settled.trades,
      candles: settled.candles,
      footprints: settled.footprints,
      livePrices: yield* latestByCode(retained?.livePrices ?? [], livePrices),
      chunks: [...(retained?.chunks ?? []), ...chunks],
      sessionBooks: yield* latestByCode(
        retained?.sessionBooks ?? [],
        endedSession
      ),
      ajaibBooks: yield* latestByCode(retained?.ajaibBooks ?? [], ajaibBooks),
      facts: {
        [Fact.feedDowns]: JSON.stringify(yield* market.record),
        ...(yield* sweepBrokers.persisting(settled.trades)),
        ...recordedCodes,
        ...(marking ? { [Fact.bookEvents]: "recorded" } : {}),
        ...(markingFlow ? { [Fact.orderFlowEvents]: "recorded" } : {}),
        ...facts,
      },
      bookEvents: events,
      orderFlowEvents: flowing,
    }
    unwritten = payload
    yield* store.write(payload)
    yield* recordedBooks.wrote(recordedCodes)
    yield* Effect.logInfo("Rows written").pipe(
      Effect.annotateLogs({ ...(yield* store.takeMeter) })
    )
    unwritten = undefined
    if (marking) bookEventsMarked = true
    if (markingFlow) orderFlowMarked = true
    yield* bookEvents.written(events.length)
    yield* orderFlowEvents.written(flowing.length)
    writtenDowns = payload.facts[Fact.feedDowns]
    yield* candles.written
  })

  // The bubbles answer is built after the flush 5 s past each minute
  // and served as is until the next; a GET before the object's first build
  // builds it. Each build logs its codes and bytes for the cost check; its
  // time is measured off the Worker, whose clock stands still while it
  // computes (bubbles.test.ts). See spec apinrdw/kumora#427, "When it is built".
  //
  // A sealed day's answer is settled before the day's end: the seal
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
      (yield* orderFlowEvents.toFlush).length > 0 ||
      (orderFlowJudged && !orderFlowMarked) ||
      (yield* candles.hasUnflushed) ||
      (yield* bookChunks.hasOpen) ||
      (yield* books.hasUnflushedAjaib) ||
      (yield* recordedBooks.hasUnwritten) ||
      (yield* sessionBooks.due((yield* market.conditions).phase)) ||
      JSON.stringify(yield* market.record) !== writtenDowns
    )
  })

  // One flush a minute while anything is left to write, a failed one
  // included, a feed lag line to log, or a session's books to write at its
  // end. A wake with nothing to write only logs, so the lines add no
  // transaction.
  // Feed lag lines are logged on this flush, 5 s past the minute, as
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
          })
        )
      ),
      // Decision: the flush and the bubbles build take separate turns
      // (apps/dashboard/docs/adr/0123-the-flush-and-the-bubbles-build-take-separate-turns.md)
      Effect.andThen(Effect.yieldNow),
      Effect.andThen(
        turn.withPermit(
          Effect.gen(function* () {
            if (sealed) return
            yield* buildBubbles.pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Bubbles not built", cause)
              )
            )
          }).pipe(
            Effect.andThen(
              Effect.all([
                unflushed,
                feedLags.hasUnlogged,
                sessionBooks.hasUnwritten,
              ])
            )
          )
        )
      ),
      Effect.flatMap(([more, logging, sessionOpen]) =>
        more || logging || sessionOpen ? armFlush : Effect.void
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
    // A day buildable at its seal builds just after it, in the
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
        ...(yield* brokerCodes.codesCompleteFactForSeal),
        ...(due ? { [Fact.brokerTotals]: BROKER_TOTALS_DUE } : {}),
      },
    })
    sealed = true
    // The next GET builds the bubbles answer from the seal's last candles.
    bubblesBody = undefined
  })

  // What a sealed day's seal still owes past its marker: the build's wake,
  // the tape summary and the storage line.
  // The seal wake stays set until all of this is done, so a
  // failure past the marker is retried a minute later, as one before it is.
  // Each step is safe to run again; a summary that failed reads the tape
  // again, about 1.46 M rows on a busy day. The build is armed first, from
  // the stored fact: no later step's failure holds it back. See PR #564.
  const finishSeal = Effect.fnUntraced(function* (now: DateTime.Utc) {
    if ((yield* store.fact(Fact.brokerTotals)) === BROKER_TOTALS_DUE)
      yield* wakes.set("build", now)
    yield* summarizeTape(options.sql)
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* sweepBrokers.storage),
      })
    )
    // The day leaving the window at this seal is asked to move, if the index
    // lists it: asking a day never recorded would make an empty object for
    // it. A failed ask waits for the reconcile cron (cold-moves.ts).
    if (today && options.cold !== undefined) {
      const { cold } = options
      const leaving = yield* leavingAt(options.date)
      yield* Effect.gen(function* () {
        if (yield* cold.listed(leaving)) yield* cold.askMove(leaving)
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("Move not asked", cause))
      )
    }
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
      if (fields === undefined || fields === null) continue
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
      alsoWrites: summarizeAddedTrades(
        options.sql,
        trades.map((trade) => Number(trade.tradeNumber))
      ),
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
  // The emptied cold day's answers (cold-days.ts `coldDay`), once the move
  // emptied the object: from then on nothing reads its store.
  let gone: ColdDay | undefined
  const arm = (at: DateTime.Utc) =>
    Effect.suspend(() => {
      if (armed !== undefined && !DateTime.isLessThan(at, armed))
        return Effect.void
      armed = at
      return setAlarm(at)
    })
  // The seal is due at 17:00 WIB, a minute after a seal that didn't land.
  // A walk day arms the seal only once buildable (`buildable`,
  // MISSING_ALLOWANCE in broker-codes.ts): until then it is never listed.
  // The batch that makes it so arms the seal at once (`walkSealDue`). See
  // spec apinrdw/kumora#437 and apinrdw/kumora#457.
  const wakes = yield* makeWakes(store, arm)
  yield* wakes.restore(
    "seal",
    sealWakeAtStart(sealed, source, buildable, sealAt)
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

  // Decision: an ingest socket still tokenless at its deadline closes with 4408
  // (apps/dashboard/docs/adr/0117-a-tokenless-ingest-socket-closes-past-its-deadline.md)
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
    // A day sealed with the wake still set finishes its seal (`finishSeal`).
    seal: Effect.fnUntraced(function* (now) {
      if (DateTime.isLessThan(now, sealAt))
        return yield* wakes.set("seal", sealAt)
      if (!sealed) {
        if (source === "unknown" || (source === "walk" && !(yield* buildable)))
          return yield* wakes.set("seal", undefined)
        yield* seal(now).pipe(retried("seal", "Day not sealed", now))
        if (!sealed) return
      }
      yield* finishSeal(now).pipe(
        Effect.andThen(wakes.set("seal", undefined)),
        retried("seal", "Seal not finished", now)
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
      if ((yield* wakes.deadline("build")) === undefined) yield* moveAfter
    }),
    // One step of the move a run, the next due at once; a failed step is
    // run again a minute later. A move not yet started that is no longer
    // due (a batch made its build pending) waits for the build to set it.
    move: Effect.fnUntraced(function* (now) {
      const stored = yield* store.fact(Fact.move)
      if (
        options.cold === undefined ||
        (stored === undefined && !(yield* moveDue))
      )
        return yield* wakes.set("move", undefined)
      const cold = options.cold
      if (cold.anyHour === undefined || !(yield* cold.anyHour)) {
        const at = yield* outsideStreaming(now)
        if (DateTime.isLessThan(now, at)) return yield* wakes.set("move", at)
      }
      yield* Effect.gen(function* () {
        const progress: MoveProgress =
          stored === undefined ? { _tag: "Answers" } : yield* decodeMove(stored)
        // The move starts: from here on a batch writes nothing.
        if (stored === undefined)
          yield* store.setFact(Fact.move, yield* encodeMove(progress))
        const next = yield* moveStep(
          options.date,
          { bucket: yield* cold.bucket, markCold: cold.markCold },
          dayToMove,
          progress
        )
        if (next === "Cold") {
          yield* cold.empty
          gone = coldDay(options.date, cold.bucket)
          return
        }
        yield* store.setFact(Fact.move, yield* encodeMove(next))
        yield* wakes.set("move", now)
      }).pipe(retried("move", "Day not moved", now))
    }),
  }

  // The alarm, set for the seal at 17:00 WIB, never fails: a seal
  // that didn't land sets the alarm a minute later, as the runner answers a
  // failure as handled, so Cloudflare would not retry it and nothing else
  // wakes the object. Every alarm sweeps the ingest sockets first. See
  // apinrdw/kumora#157.
  const alarm = Effect.gen(function* () {
    armed = undefined
    const now = yield* DateTime.now
    for (const wake of WAKES)
      if (yield* wakes.due(wake, now)) yield* duties[wake](now)
    if (gone === undefined) yield* sweepIngests
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
  // Decision: a day no longer buildable loses its built figures and reads as a gap
  // (apps/dashboard/docs/adr/0118-a-day-no-longer-buildable-reads-as-a-gap.md)
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

  // A batch that corrects a built or stale day marks it stale and
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

  // Decision: the reconcile cron's poke builds a sealed, buildable day at once
  // (apps/dashboard/docs/adr/0119-the-reconcile-poke-builds-a-sealed-day-at-once.md)
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
  // Decision: 4403 refuses the token, 4426 a protocol; both stop ingest retries
  // (packages/relay/docs/adr/0003-ingest-socket-closes-4403-and-4426-stop-retries.md)
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
          yield* liveDowns
          yield* socket.setState("ready")
          yield* market.relayOnline
          yield* scheduleDelta
          yield* previousValues.load
          return yield* onDemand.greet(socket)
        }
        return yield* socket.close(IngestCloseCode.RejectedToken, "Bad token")
      }
      const message = yield* decodeIngestUp(text)
      // Decision: a day's code list is fixed once taken; only a missing one is filled
      // (apps/dashboard/docs/adr/0120-a-day-s-code-list-is-fixed-once-taken.md)
      if (!(yield* takesIngest)) {
        if (
          message._tag === "CodeList" &&
          Option.isNone(yield* codeListStore.read)
        )
          yield* storeList(message.body)
        return
      }
      yield* market.ingest(message)
      if (message._tag === "CodeList") return yield* storeList(message.body)
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

  // Codes a viewer watches join the recorded books if listed, each recorded
  // from now to the close. A sealed day's recorded books are fixed: a code viewed
  // after the seal gets its live book but stays not recorded.
  // Each joining code's chunk opens from the book its viewer is served.
  const recordWatched = Effect.fnUntraced(function* (
    watching: ReadonlyArray<StockCode>,
    live: boolean
  ) {
    if (sealed) return
    if (listed === undefined) listed = yield* listedCodes(codeListStore)
    for (const code of watching) {
      if (!(yield* recordedBooks.join(code, listed))) continue
      const book = yield* books.bookOf(code, live)
      if (book?._tag === "OrderBook") yield* bookChunks.begin(book)
    }
  })

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
      yield* liveDay
      const live = yield* stockbitLive
      const orderBook = yield* books.bookOf(selected, live)
      // The selected code first: on-demand.ts reads it back as the selection.
      const watching = [...new Set([selected, ...watchlist])]
      yield* recordWatched(watching, live)
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
      const newestOrderFlow = yield* orderFlowEvents.newest
      const selectedOrderFlow = yield* orderFlowEvents.ofCode(selected)
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
          standoutSweeps: standouts,
          bookEvents: newestEvents,
          selectedBookEvents: selectedEvents,
          orderFlowEvents: newestOrderFlow,
          selectedOrderFlowEvents: selectedOrderFlow,
        })),
        ...(bookReadings.length === 0 ? {} : { bookReadings, scannerFigures }),
      })
      yield* socket.send(snapshot)
      yield* socket.setState("ready")
      // A snapshot arms the flush, so a viewer that came after the
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
  // The relay is offline when the closed socket was ready and no
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
    yield* liveDowns
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
    // The object encoded them itself.
    const unwrittenChunks = yield* Effect.forEach(
      (unwritten?.chunks ?? []).filter((chunk) => chunk.code === code),
      (chunk) => Effect.orDie(heldChunkOf(chunk.chunk))
    )
    return yield* Effect.forEach(
      [...unwrittenChunks, ...(yield* bookChunks.held(code))],
      Effect.fnUntraced(function* (chunk) {
        return {
          minute: chunk.minute,
          slices: yield* chunkSlices(chunk, through),
          endBook: endBookOf(chunk),
        }
      })
    )
  })

  // A sealed day's order flow GET, and any day's sweep brokers GET, builds
  // the rows first if the day needs it: it never answers empty. GETs take
  // the turn, so a second GET awaits the first's build.
  // Decision: build progress names the rows' shape, so an older shape rebuilds
  // (apps/dashboard/docs/adr/0081-the-sweep-brokers-build-names-its-rows-shape.md)
  const builtFirst = Effect.fnUntraced(function* (resource: RecordedResource) {
    if (resource._tag === "SweepBrokers") return yield* sweepBrokers.builtFirst
    if (!sealed || orderFlowBuilt) return
    if (resource._tag !== "Candles" && resource._tag !== "Sweeps") return
    yield* buildOrderFlow(store)
    orderFlowBuilt = true
  })

  // A walk day answers bubbles as a past day does, 404, even on its
  // own date: Market Bubbles is live only, and a History walk sends no live
  // tape, so its bubble book never fills. See apinrdw/kumora#436.
  const recorded = (resource: RecordedResource) =>
    resource._tag === "Bubbles"
      ? Effect.flatMap(dayEnded, (ended) =>
          bubblesAnswer(
            ended || source === "walk",
            Effect.suspend(() =>
              bubblesBody === undefined
                ? Effect.andThen(liveDay, buildBubbles)
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
            takesCodes,
            sealed,
            liveGaps: Effect.map(
              market.conditions,
              (conditions) => conditions.gaps
            ),
            heldHeat,
            booksNotRecorded: recordedBooks.notRecorded,
            sweeps: candles.sweepsOf,
            bookEvents: Effect.fnUntraced(function* (code: StockCode) {
              return {
                recorded: today || bookEventsMarked,
                events: yield* bookEvents.ofCode(code),
              }
            }),
            orderFlowEvents: Effect.fnUntraced(function* (code: StockCode) {
              return {
                recorded: today || orderFlowMarked,
                events: yield* orderFlowEvents.ofCode(code),
              }
            }),
          })
        )

  // Every code's value, once sealed (previous-values.ts).
  const dayValues = Effect.suspend(() =>
    dayValuesAnswer(
      sealed,
      Effect.map(store.storedBubbles(0), ({ days }) =>
        days.map(({ code, sums }) => ({ code, value: sums.value }))
      )
    )
  )

  // What a sealed day's move to R2 reads (cold-days.ts): its answers as
  // `recorded` builds them, for every code its list names or it holds data
  // of.
  const dayToMove = {
    answer: recorded,
    status: brokerCodes.status(new URLSearchParams()),
    dayValues,
    bookEvents: {
      recorded: Effect.sync(() => today || bookEventsMarked),
      codes: store.bookEventCodes,
    },
    orderFlowEvents: {
      recorded: Effect.sync(() => today || orderFlowMarked),
      codes: store.orderFlowEventCodes,
    },
    codes: Effect.gen(function* () {
      const codes = new Set(yield* store.dayCodes)
      for (const code of (yield* listedCodes(codeListStore)) ?? [])
        codes.add(code)
      return [...codes].sort()
    }),
    tape: {
      below: (before, limit) =>
        store.tradesAt(
          before === undefined
            ? { at: AFTER_EVERY_TRADE }
            : { at: AFTER_EVERY_TRADE, before },
          limit
        ),
      codes: (tradeNumbers) => brokerCodes.heldCodes(tradeNumbers),
      complete: brokerCodes.codesComplete,
    },
    books: { codes: store.bookCodes, chunksOf: store.storedChunksOf },
  } satisfies DayToMove

  // Whether the day is due to move: sealed, no build pending, and its walk
  // done (its codes complete and its broker totals built at this version)
  // or out of the window.
  const moveDue = Effect.gen(function* () {
    if (!sealed || options.cold === undefined) return false
    if ((yield* wakes.deadline("build")) !== undefined) return false
    if (
      (yield* brokerCodes.codesComplete) &&
      (yield* store.fact(Fact.brokerTotals)) === String(BROKER_TOTALS_VERSION)
    )
      return true
    return yield* pastWindow(options.date, yield* DateTime.now)
  })

  // Sets the day's move for when it may start, once it is due; whether the
  // day moves.
  // Decision: a day takes broker codes until its move starts; answers say so
  // (packages/relay/docs/adr/0001-a-day-takes-broker-codes-until-its-cold-move-starts.md)
  const startMove = Effect.gen(function* () {
    if (options.cold === undefined) return false
    if ((yield* store.fact(Fact.move)) !== undefined) return true
    if ((yield* wakes.deadline("move")) !== undefined) return true
    if (!(yield* moveDue)) return false
    const now = yield* DateTime.now
    yield* wakes.set(
      "move",
      DateTime.toEpochMillis(now) < dayEnd ? DateTime.makeUnsafe(dayEnd) : now
    )
    return true
  })
  // The build's and a batch's start: one that failed waits for the next
  // batch, build or reconcile cron (cold-moves.ts).
  const moveAfter = startMove.pipe(
    Effect.catchCause((cause) => Effect.logError("Move not started", cause)),
    Effect.asVoid
  )

  // Once the move's first step ran, a batch is answered as taken and writes
  // nothing, as an emptied object's (cold-days.ts `takenUnwritten`).
  const moving = Effect.map(
    store.fact(Fact.move),
    (progress) => progress !== undefined
  )

  // Whether the day still takes broker codes, as its sweep brokers answer
  // tells a follower (followSweepBrokers): until its move's first step.
  // With no cold storage a day never moves and writes codes for
  // good, but tells a follower it takes them only while hot (`pastWindow`),
  // as a cold stage would: codes a still-incomplete older day gets later
  // show on the page's next load, not live. See PR #632.
  const takesCodes =
    options.cold === undefined
      ? Effect.map(
          Effect.flatMap(DateTime.now, (now) => pastWindow(options.date, now)),
          (past) => !past
        )
      : Effect.map(moving, (frozen) => !frozen)

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

  // Once a WIB day, an object that ran logs what its SQL adapter
  // counted since its last line, after a callback it already takes: on its
  // own date the seal's, else the date's first. No alarm wakes it for this.
  // The date is a fact, read once, so a restart logs no second line. See
  // apinrdw/kumora#558.
  let usageLogged = yield* store.fact(Fact.usageLogged)
  const usageLine = Effect.gen(function* () {
    if (gone !== undefined) return
    const date = yield* wibDateAt(yield* DateTime.now)
    if (usageLogged === date || (date === options.date && !sealed)) return
    const usage = yield* store.takeUsage
    if (usage === undefined) return
    yield* store.setFact(Fact.usageLogged, date)
    usageLogged = date
    yield* Effect.logInfo("Durable Object usage").pipe(
      Effect.annotateLogs(usage)
    )
  })
  // A callback, in the turn, ending with the day's usage line when due; once
  // the move emptied the object, `whenGone` instead.
  const turned = <A, E, R, A2, E2, R2>(
    callback: Effect.Effect<A, E, R>,
    whenGone: (emptied: ColdDay) => Effect.Effect<A2, E2, R2>
  ) =>
    turn.withPermit(
      Effect.suspend((): Effect.Effect<A | A2, E | E2, R | R2> =>
        gone === undefined
          ? Effect.tap(callback, () => usageLine)
          : whenGone(gone)
      )
    )
  const nothing = () => Effect.void

  return {
    ingestOpened: turned(ingestOpened, nothing),
    ingestMessage: (socket: Peer, text: string) =>
      turned(ingestMessage(socket, text), nothing),
    viewerMessage: (socket: Peer, text: string) =>
      turned(viewerMessage(socket, text), () =>
        socket.close(ViewerCloseCode.DayEnded, "Day ended")
      ),
    viewerClosed: (socket: Peer) => turned(viewerClosed(socket), nothing),
    ingestClosed: (socket: Peer) => turned(ingestClosed(socket), nothing),
    endSessions: (held: HeldSessions) => turned(endSessions(held), nothing),
    recorded: (resource: RecordedResource) =>
      turned(recorded(resource), (emptied) => emptied.recorded(resource)),
    // A newer day's seal, or the reconcile cron, asks the day to move:
    // whether it moves.
    move: turned(startMove, () => Effect.succeed(false)),
    alarm: turned(alarm, nothing),
    // Every code's value, for the next trading day's object; a cold day's
    // as its move stored them.
    dayValues: turned(dayValues, (emptied) => emptied.dayValues),
    // Decision: broker codes touch no recorded state of a relay or sealed day
    // (apps/dashboard/docs/adr/0121-broker-codes-touch-no-recorded-day-state.md)
    brokerCodes: {
      // A batch that changes codes rewrites its trades' sweep
      // brokers rows from their minutes' stored trades, in the codes' turn
      // and transaction, before its 200; one that changes none recomputes
      // nothing. See spec apinrdw/kumora#343, "When it is recomputed".
      // A batch that leaves the day due to move sets its move.
      post: (text: string) =>
        turned(
          Effect.flatMap(moving, (frozen) =>
            frozen
              ? takenUnwritten(text, options.date)
              : brokerCodes.post(text, {
                  taken: walkTapeOf,
                  alongside: sweepBrokers.recompute,
                  // Broker totals before sweep brokers: its scan is the one
                  // sweep brokers' check reads.
                  written: (corrected) =>
                    walkSealDue.pipe(
                      Effect.andThen(totalsWritten(corrected)),
                      Effect.andThen(sweepBrokers.completed),
                      Effect.andThen(moveAfter)
                    ),
                })
          ),
          (emptied) => emptied.post(text)
        ),
      status: (search: URLSearchParams) =>
        turned(brokerCodes.status(search), (emptied) => emptied.status(search)),
      held: (tradeNumber: TradeNumber) =>
        turned(brokerCodes.held(tradeNumber), () =>
          Effect.die("The day moved")
        ),
      heldOrders: (tradeNumber: TradeNumber) =>
        turned(brokerCodes.heldOrders(tradeNumber), () =>
          Effect.die("The day moved")
        ),
    },
    brokerTotals: {
      reconcile: turned(reconcile, () => Effect.succeed(false)),
    },
  }
})
