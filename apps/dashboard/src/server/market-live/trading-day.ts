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
  type DayState,
  type IndicativePrice,
  type IngestUp,
  type RecordedDay,
  type RecordedResource,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Clock, DateTime, Duration, Effect, Schema, Scope } from "effect"

import { ajaibTrades } from "./ajaib.ts"
import { ajaibPrices } from "./ajaib-price.ts"
import { backfillTrades } from "./backfill-page.ts"
import { makeBookChunks } from "./book-chunks.ts"
import { makeCandleBook, minuteOf } from "./candles.ts"
import {
  memoryCodeListStore,
  storeCodeList,
  type CodeListStore,
} from "./code-list.ts"
import { makeDayStates } from "./day-states.ts"
import { Fact, makeDayStore, type Flush, type Sql } from "./day-store.ts"
import type { DownRecord } from "./feed-health.ts"
import { makeGaps } from "./gaps.ts"
import { makeMarketConditions } from "./market-conditions.ts"
import { makeOnDemand } from "./on-demand.ts"
import { makeOrderBooks } from "./order-books.ts"
import { SNAPSHOT_TRADES, recordedAnswer } from "./recorded-answers.ts"
import { type AccountId, type HeldSessions, type SessionId } from "./routes.ts"
import { stockbitTrades } from "./stockbit.ts"
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
}

// A viewer socket and the session it was gated with; none for a socket
// tagged without one, which no held session keeps open.
export interface SessionViewer {
  readonly peer: Peer
  readonly sessionId: SessionId | undefined
}

// How often viewers get the trades that arrived since the last delta.
const DELTA_INTERVAL = "250 millis"

// Decision: the tape in memory holds the newest 10,000 trades, the most the
// page keeps; a restarted object reloads them from the day store. A trade
// older than that window is still deduped against the store and still counts
// in its candle, and a second feed's copy still merges into it while its
// merge window is open (the candle book holds it), but viewers aren't sent
// it: the page keeps the same window.
const TAPE_LIMIT = 10_000

// Decision: trades, candles, last `liveprice` frames, book chunks, whole
// Ajaib books and the feeds' record are written to the day store once a minute, 5 s past the
// minute (spec apinrdw/kumora#138, "Storage and cost"), so each flush closes
// the minute that just ended: its book chunks, and its trades' 5 s merge
// windows. The one exception is the relay going offline (`ingestClosed`),
// which flushes at once, mid-minute, so a restart keeps the relay gap from
// that instant. Each trade is written once. A flush whose write failed keeps
// what it took, and the next flush, a minute later, writes it with what
// settled since, so a candle is never stored without the trades it counted;
// the candle book keeps the trades and candles, still held against a late
// copy (candles.ts), and the day the rest. A restart loses at most the
// minute in progress and an unwritten flush, which the relay's backfill
// refills from the next gap.
const MINUTE = 60_000
const FLUSH_PAST_MINUTE = 5_000

// IHSG's close and change on the strip, from its last `liveprice` frame.
const ihsgOf = (price: LivePrice | undefined) => {
  if (price?.last === undefined) return {}
  const previous = price.previous ?? price.last
  const change = price.change ?? price.last - previous
  const changePercent =
    price.changePercent ?? (previous === 0 ? 0 : (change / previous) * 100)
  return { ihsg: { close: price.last, change, changePercent } }
}

const IHSG = StockCode.make("IHSG")

// One row per code from two flushes' rows, the later flush's replacing the
// earlier's.
const latestByCode = <T extends { readonly code: StockCode }>(
  earlier: ReadonlyArray<T>,
  later: ReadonlyArray<T>
) => {
  const codes = new Set(later.map((row) => row.code))
  return [...earlier.filter((row) => !codes.has(row.code)), ...later]
}

// Decision: a viewer whose session ended is closed with 4401 when it would
// next be served, a delta or a snapshot, not by a timer: that is where it
// would otherwise get data, and it needs nothing the object keeps in memory,
// so it holds across hibernation. An idle expired socket stays open, served
// nothing, until then. A viewer tagged without an end is closed the same way,
// as the sessions a user holds keep open no socket tagged without a session
// (`endSessions`).
const sessionEnded = Effect.fnUntraced(function* (viewer: Peer) {
  if (viewer.sessionEnd === undefined) return false
  const end = yield* viewer.sessionEnd
  return end === undefined || end <= (yield* Clock.currentTimeMillis)
})

const signInRequired = (viewer: Peer) =>
  viewer.close(ViewerCloseCode.SignInRequired, "Sign in")

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

// How often the object checks whether the market conditions changed: a feed
// going stale is noticed within this.
const CONDITIONS_INTERVAL = "1 second"

const encodeConditions = Schema.encodeEffect(
  Schema.fromJsonString(MarketConditions)
)

const sha256 = (text: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  ).pipe(Effect.map((digest) => new Uint8Array(digest).toString()))

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
  const minutes = new Set(prices.map((price) => minuteOf(price.time)))
  for (const minute of minutes)
    for (const trade of yield* day.store.tradesBetween(
      DateTime.makeUnsafe(minute - 1),
      DateTime.makeUnsafe(minute + MINUTE - 1)
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
}) {
  // Delta timers outlive the message that started them.
  const scope = yield* Scope.Scope
  const codeListStore = options.codeList ?? (yield* memoryCodeListStore)
  const store = yield* makeDayStore(options.sql)
  const setAlarm = options.setAlarm ?? (() => Effect.void)
  let sealed = (yield* store.fact(Fact.sealed)) !== undefined
  // Decision: an object restores the live day from its store unless the day
  // is sealed and past: a past day's object only answers recorded day GETs,
  // straight from the store. Today's still serves viewers after the seal.
  const today = (yield* wibDateAt(yield* DateTime.now)) === options.date
  const restoring = !sealed || today
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

  // The order book and Day state fall back to Ajaib while Stockbit isn't live.
  const stockbitLive = Effect.map(
    market.conditions,
    (conditions) => conditions.feeds.Stockbit === "live"
  )
  // The market conditions viewers were last sent, encoded.
  let sentConditions = ""
  let relayOnline = false
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

  const inTape = (trade: RunningTrade) =>
    tape[positionOf(tape, trade)]?.tradeNumber === trade.tradeNumber

  // A copy of a trade the day holds, merged into the tape row at `slot`, or
  // into the candle book's copy once the tape evicted it. A copy that adds
  // no feed and no side changes nothing.
  const mergeInto = Effect.fnUntraced(function* (
    held: RunningTrade,
    arriving: RunningTrade,
    slot: number | undefined
  ) {
    const merged = yield* settleSide(merge(held, arriving))
    if (merged.feeds.length === held.feeds.length && merged.side === held.side)
      return
    if (slot !== undefined) {
      tape[slot] = merged
      pending.set(merged.tradeNumber, merged)
    }
    yield* candles.trade(held, merged)
    yield* dayStates.trade(held, merged)
  })

  // Merges each trade into the tape: a new trade number is inserted in its
  // place, a known one merged with what other feeds saw, on the tape or, once
  // the tape evicted it, inside its merge window. A new trade older than a
  // full tape's oldest counts in its candle but stays off the tape.
  const insert = Effect.fnUntraced(function* (
    trades: ReadonlyArray<RunningTrade>
  ) {
    for (const arriving of trades) {
      yield* gaps.seen(arriving)
      const at = positionOf(tape, arriving)
      // The tape row of this number, if it holds one.
      const slot =
        tape[at]?.tradeNumber === arriving.tradeNumber ? at : undefined
      const held =
        slot === undefined
          ? yield* candles.openTrade(arriving.tradeNumber)
          : tape[slot]
      if (held !== undefined) {
        yield* mergeInto(held, arriving, slot)
        continue
      }
      const beforeTape = at === 0 && tape.length >= TAPE_LIMIT
      if (yield* heldOutsideTape(arriving, beforeTape)) continue
      const trade = yield* settleSide(arriving)
      if (!beforeTape) {
        tape.splice(at, 0, trade)
        if (tape.length > TAPE_LIMIT) tape.shift()
        pending.set(trade.tradeNumber, trade)
      }
      yield* candles.trade(undefined, trade)
      yield* dayStates.trade(undefined, trade)
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
    for (const book of orderBooks) yield* bookChunks.record(book)
    const states = yield* dayStates.takeChanged(live, yield* onDemand.watched)
    const conditions = yield* market.conditions
    const encoded = yield* encodeConditions(conditions)
    const conditionsChanged = encoded !== sentConditions
    sentConditions = encoded
    const indicative = yield* market.indicativeChanges
    if (
      trades.length === 0 &&
      changed.length === 0 &&
      orderBooks.length === 0 &&
      states.length === 0 &&
      !conditionsChanged &&
      indicative.length === 0
    )
      return
    const text = yield* encodeViewerDown({
      _tag: "Delta",
      tape: trades,
      candles: changed,
      ...(orderBooks.length > 0 ? { orderBooks } : {}),
      ...(states.length === 0 ? {} : { dayStates: states }),
      ...(conditionsChanged ? { conditions } : {}),
      ...(indicative.length > 0 ? { indicative } : {}),
    })
    for (const viewer of yield* options.viewers) {
      if ((yield* viewer.state) !== "ready") continue
      if (yield* sessionEnded(viewer)) yield* signInRequired(viewer)
      else yield* viewer.send(text)
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
      Effect.andThen(sendDelta),
      Effect.catchCause((cause) => Effect.logError("Delta not sent", cause)),
      Effect.forkIn(scope)
    )
  })

  // Decision: while a viewer is connected, the object looks at the market
  // conditions every second and sends a delta when they changed, so a feed
  // going stale or the phase turning reaches viewers without a frame. With
  // no viewer it stops: freshness and relay gaps are decided from the
  // instants of frames and closes, not from these checks, and a snapshot
  // reads them fresh.
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
      yield* scheduleDelta.pipe(
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
    const settled = yield* candles.takeSettled(final)
    const chunks = yield* bookChunks.take(final)
    const livePrices = [...livePricesChanged.values()]
    livePricesChanged = new Map()
    const ajaibBooks = yield* books.takeAjaibBooks
    const retained = unwritten
    const payload: Flush = {
      trades: settled.trades,
      candles: settled.candles,
      livePrices: latestByCode(retained?.livePrices ?? [], livePrices),
      chunks: [...(retained?.chunks ?? []), ...chunks],
      ajaibBooks: latestByCode(retained?.ajaibBooks ?? [], ajaibBooks),
      facts: {
        [Fact.feedDowns]: JSON.stringify(yield* market.record),
        ...facts,
      },
    }
    unwritten = payload
    yield* store.write(payload)
    unwritten = undefined
    yield* candles.written
  })

  const unflushed = Effect.gen(function* () {
    return (
      unwritten !== undefined ||
      livePricesChanged.size > 0 ||
      (yield* candles.hasUnflushed) ||
      (yield* bookChunks.hasOpen) ||
      (yield* books.hasUnflushedAjaib)
    )
  })

  // One flush a minute while anything is left to write, a failed one
  // included.
  const scheduleFlush: Effect.Effect<void> = Effect.suspend(() => {
    if (flushScheduled || sealed) return Effect.void
    flushScheduled = true
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.sleep(
          Duration.millis(
            MINUTE - ((((now - FLUSH_PAST_MINUTE) % MINUTE) + MINUTE) % MINUTE)
          )
        )
      ),
      Effect.andThen(
        Effect.suspend(() => {
          flushScheduled = false
          return sealed
            ? Effect.void
            : flush(false).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Day not flushed", cause)
                )
              )
        })
      ),
      Effect.andThen(unflushed),
      Effect.flatMap((more) => (more ? scheduleFlush : Effect.void)),
      Effect.forkIn(scope),
      Effect.asVoid
    )
  })

  // The seal: everything left, the day's relay gaps and the index row are
  // written, then the sealed marker; after it the day takes no ingest and
  // its answers are immutable.
  const seal = Effect.fnUntraced(function* (now: DateTime.Utc) {
    const conditions = yield* market.conditions
    yield* flush(true, {
      [Fact.gaps]: yield* encodeRecordedGaps({ gaps: conditions.gaps }),
    })
    const trades = yield* store.storedTrades
    if (trades > 0)
      yield* (options.recordDay ?? (() => Effect.void))({
        day: options.date,
        ...ihsgOf(yield* store.livePrice(IHSG)),
        trades,
        gap: conditions.gaps.length > 0,
      })
    yield* store.write({
      trades: [],
      candles: [],
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: { [Fact.sealed]: DateTime.formatIso(now) },
    })
    sealed = true
  })

  // Decision: the alarm, set for the seal at 17:00 WIB, never fails: an
  // early alarm sets itself again, and a seal that didn't land, whether its
  // final flush, its index row or its sealed marker, sets the alarm a minute
  // later and seals then. The Durable Object's runner answers a failure as
  // handled, so Cloudflare would not retry the alarm, and nothing else wakes
  // an object whose relay has gone for the day; the retry keeps what the
  // failed flush took.
  const alarm = Effect.gen(function* () {
    if (sealed) return
    const at = yield* sealInstant(options.date)
    const now = yield* DateTime.now
    if (DateTime.isLessThan(now, at)) return yield* setAlarm(at)
    yield* seal(now).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Day not sealed", cause).pipe(
          Effect.andThen(setAlarm(DateTime.add(now, { minutes: 1 })))
        )
      )
    )
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
        const held = lastLivePrices.get(price.code)
        // The store keeps each code's regular-board frame, the one a restart
        // rebuilds its Day state from: a cash or negotiated board's would
        // displace it.
        if (
          price.regularBoard &&
          (held === undefined || DateTime.isGreaterThan(price.time, held.time))
        ) {
          const merged = yield* mergedLivePrice(held, price)
          lastLivePrices.set(price.code, merged)
          livePricesChanged.set(price.code, merged)
        }
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
      // A sealed day takes nothing more.
      if (sealed) return
      yield* market.ingest(message)
      if (message._tag === "CodeList")
        return yield* storeCodeList(codeListStore, message.body)
      // A page fills only numbers the day lacks: a held trade keeps the feeds
      // that saw it live.
      if (message._tag === "BackfillPage")
        yield* insert(
          yield* Effect.filter(
            yield* backfillTrades(options.date, message),
            (trade) =>
              inTape(trade)
                ? Effect.succeed(false)
                : Effect.map(heldOutsideTape(trade, true), (held) => !held)
          )
        )
      if (message._tag === "Frames") yield* framesIn(message)
      yield* scheduleDelta
      yield* scheduleFlush
    },
    (effect, socket) =>
      Effect.catchTag(effect, "ProtocolVersionMismatch", (error) =>
        socket.close(error.closeCode, "Protocol version mismatch")
      )
  )

  // The page's Select, on open and on every change: answered with a snapshot,
  // after which the socket gets deltas. A Select the object couldn't serve,
  // its codes not kept or the on-demand set not sent, closes the socket with
  // 1011 (the failure is still logged): the page reconnects and sends its
  // Select again, rather than sitting connected with its codes off the set.
  const viewerMessage = Effect.fnUntraced(
    function* (socket: Peer, text: string) {
      if (yield* sessionEnded(socket)) return yield* signInRequired(socket)
      const { selected, watchlist } = yield* decodeViewerUp(text)
      const live = yield* stockbitLive
      const orderBook = yield* books.bookOf(selected, live)
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

  // A ready ingest socket closed, leaving `remaining` ready ones. With none,
  // the relay is offline: written at once, as nothing else may arrive to
  // schedule a flush before the object is evicted, and a restart would count
  // the gap from its own start.
  const ingestClosed = Effect.fnUntraced(function* (remaining: number) {
    if (remaining > 0 || !relayOnline) return
    relayOnline = false
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
  const recorded = (resource: RecordedResource) =>
    Effect.suspend(() =>
      recordedAnswer(resource, {
        date: options.date,
        store,
        codeList: codeListStore,
        sealed,
        liveGaps: Effect.map(
          market.conditions,
          (conditions) => conditions.gaps
        ),
      })
    )

  if (!sealed) yield* setAlarm(yield* sealInstant(options.date))

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
    ingestMessage,
    viewerMessage,
    viewerClosed,
    ingestClosed,
    endSessions,
    recorded,
    alarm,
  }
})
