// Recorded day loads (spec apinrdw/kumora#138, "Recorded day loads" and
// "Seal and the index Durable Object"): plain GETs under `/market-live/days/*`,
// each answered by the named day's trading-day Durable Object, and the day
// strip, answered by the index Durable Object. The Worker entry reads a path
// back with `recordedDayRequest`; the page builds it with `recordedDayPath`.
import { DateTime, Effect, Option, Schema, SchemaGetter } from "effect"

import { BookEvent } from "./book-events.ts"
import {
  BrokerCode,
  DayTradeNumber,
  InvestorType,
  OrderNumber,
  TradeCodes,
} from "./broker-codes.ts"
import { StockCode } from "./codes.ts"
import {
  Candle,
  Footprint,
  RunningTrade,
  Sweep,
  SweepFields,
  TradeNumber,
  ViewerProtocolVersion,
} from "./envelope.ts"
import { RelayGap } from "./market-conditions.ts"
import { BookLevel, BookSideFields, OrderBook } from "./order-book.ts"
import { WibDate } from "./schedule.ts"

const DAYS = "/market-live/days"

// The day strip: every sealed day, newest first.
export const DayStripPath = DAYS

// Where a tape answer ends. `at` alone can't continue inside one instant
// once more than a page of trades share it, so a walk backwards also passes
// the oldest trade number it holds as `before` (apinrdw/kumora#511).
export interface TapeCursor {
  readonly at: DateTime.Utc
  readonly before?: TradeNumber
}

// What one recorded day GET asks its day's object for.
export type RecordedResource =
  // The day's stock code list.
  | { readonly _tag: "Codes" }
  // The 200 newest running trades at or before `at`, below `before` when it
  // is given.
  | ({ readonly _tag: "Tape" } & TapeCursor)
  // The broker codes of the trades the tape at the same cursor holds.
  | ({ readonly _tag: "BrokerCodes" } & TapeCursor)
  // One code's whole-day candles and its previous close.
  | { readonly _tag: "Candles"; readonly code: StockCode }
  // One code's sweeps for the day so far (sweeps.ts).
  | { readonly _tag: "Sweeps"; readonly code: StockCode }
  // The brokers of one code's whole sweeps (RecordedSweepBrokers).
  | { readonly _tag: "SweepBrokers"; readonly code: StockCode }
  // One code's stored order book chunk for the minute holding `minute`.
  | {
      readonly _tag: "Book"
      readonly code: StockCode
      readonly minute: DateTime.Utc
    }
  // The day's relay gaps.
  | { readonly _tag: "Gaps" }
  // One code's book heatmap slices so far (heatmap.ts).
  | { readonly _tag: "Heatmap"; readonly code: StockCode }
  // One code's book events so far (book-events.ts).
  | { readonly _tag: "BookEvents"; readonly code: StockCode }
  // Every code's recent minutes and day totals, for Market Bubbles: the live
  // day only.
  | { readonly _tag: "Bubbles" }

// Decision: a cursor without `before` writes the query a page has always
// asked, not an empty `before=`, so a sealed answer the browser cached by its
// whole URL is still reused. See ticket apinrdw/kumora#511.
const cursorQuery = Effect.fnUntraced(function* (cursor: TapeCursor) {
  const at = `at=${DateTime.toEpochMillis(cursor.at)}`
  return cursor.before === undefined ? at : `${at}&before=${cursor.before}`
})

export const recordedDayPath = (date: WibDate, resource: RecordedResource) =>
  Effect.gen(function* () {
    const base = `${DAYS}/${date}`
    switch (resource._tag) {
      case "Codes":
        return `${base}/codes`
      case "Tape":
        return `${base}/trades?${yield* cursorQuery(resource)}`
      case "BrokerCodes":
        return `${base}/broker-codes?${yield* cursorQuery(resource)}`
      // Decision: the path carries the viewer protocol's version: the browser
      // caches a sealed answer for a year by its whole URL, so one cached
      // before footprints rode with the candles is never reused. The query is
      // ignored when read, so an older build's tab still loads. See ticket
      // apinrdw/kumora#270.
      case "Candles":
        return `${base}/candles/${resource.code}?v=${ViewerProtocolVersion}`
      case "Sweeps":
        return `${base}/sweeps/${resource.code}`
      case "SweepBrokers":
        return `${base}/sweep-brokers/${resource.code}`
      case "Book":
        return `${base}/books/${resource.code}?minute=${DateTime.toEpochMillis(resource.minute)}`
      case "Gaps":
        return `${base}/gaps`
      case "Heatmap":
        return `${base}/heatmap/${resource.code}`
      case "BookEvents":
        return `${base}/book-events/${resource.code}`
      case "Bubbles":
        return `${base}/bubbles`
    }
  })

// The day's stock code list path; the page fetches it.
export const stockCodeListPath = (date: WibDate) =>
  recordedDayPath(date, { _tag: "Codes" })

const decodeDate = Schema.decodeUnknownOption(WibDate)
const decodeCode = Schema.decodeUnknownOption(StockCode)
const decodeDayTradeNumber = Schema.decodeUnknownOption(DayTradeNumber)

const instantOf = Effect.fnUntraced(function* (text: string | undefined) {
  return text !== undefined && /^\d{1,15}$/.test(text)
    ? Option.some(DateTime.makeUnsafe(Number(text)))
    : Option.none<DateTime.Utc>()
})

// A query's parameters: the paths above carry digits only, so nothing in
// them is escaped.
const parametersOf = Effect.fnUntraced(function* (search: string) {
  return new Map(
    search
      .replace(/^\?/, "")
      .split("&")
      .map((pair) => {
        const at = pair.indexOf("=")
        return at < 0
          ? ([pair, ""] as const)
          : ([pair.slice(0, at), pair.slice(at + 1)] as const)
      })
  )
})

// A tape cursor's query: `at`, and `before` when it names a trade.
const cursorOf = Effect.fnUntraced(function* (
  search: ReadonlyMap<string, string>
) {
  const at = yield* instantOf(search.get("at"))
  const before = search.get("before")
  if (before === undefined)
    return Option.map(at, (instant): TapeCursor => ({ at: instant }))
  return Option.zipWith(
    at,
    decodeDayTradeNumber(before),
    (instant, number): TapeCursor => ({ at: instant, before: number })
  )
})

// The resources whose path names no code and no instant. A Map, so a path
// like `/constructor` reads no prototype member.
const BARE: ReadonlyMap<string, RecordedResource> = new Map([
  ["codes", { _tag: "Codes" }],
  ["gaps", { _tag: "Gaps" }],
  ["bubbles", { _tag: "Bubbles" }],
])

// The resources whose path names one code and nothing else, by path part.
const CODED: ReadonlyMap<
  string,
  "Candles" | "Heatmap" | "Sweeps" | "SweepBrokers" | "BookEvents"
> = new Map([
  ["candles", "Candles"],
  ["heatmap", "Heatmap"],
  ["sweeps", "Sweeps"],
  ["sweep-brokers", "SweepBrokers"],
  ["book-events", "BookEvents"],
] as const)

const resourceOf = Effect.fnUntraced(function* (
  parts: ReadonlyArray<string>,
  search: ReadonlyMap<string, string>
): Effect.fn.Return<Option.Option<RecordedResource>> {
  const [kind, code, ...rest] = parts
  if (rest.length > 0) return Option.none()
  if (code === undefined) {
    const bare = kind === undefined ? undefined : BARE.get(kind)
    if (bare !== undefined) return Option.some(bare)
    if (kind === "trades")
      return Option.map(yield* cursorOf(search), (cursor) => ({
        _tag: "Tape" as const,
        ...cursor,
      }))
    if (kind === "broker-codes")
      return Option.map(yield* cursorOf(search), (cursor) => ({
        _tag: "BrokerCodes" as const,
        ...cursor,
      }))
    return Option.none()
  }
  const coded = CODED.get(kind ?? "")
  if (coded !== undefined)
    return Option.map(decodeCode(code), (stock) => ({
      _tag: coded,
      code: stock,
    }))
  if (kind === "books")
    return Option.zipWith(
      decodeCode(code),
      yield* instantOf(search.get("minute")),
      (stock, minute) => ({ _tag: "Book" as const, code: stock, minute })
    )
  return Option.none()
})

// The day and resource a request's path and query name; none for any other
// path, the day strip's included. A URL fits `location`.
export const recordedDayRequest = (location: {
  readonly pathname: string
  readonly search: string
}) =>
  Effect.gen(function* () {
    const url = location
    if (!url.pathname.startsWith(`${DAYS}/`))
      return Option.none<{ date: WibDate; resource: RecordedResource }>()
    const [day, ...parts] = url.pathname.slice(DAYS.length + 1).split("/")
    return Option.zipWith(
      decodeDate(day),
      yield* resourceOf(parts, yield* parametersOf(url.search)),
      (date, resource) => ({ date, resource })
    )
  })

// The book events answer: one code's events for the day so far, oldest
// first. `recorded` is false for a day the object kept no book events of,
// one recorded before them: its page says so rather than "none".
const RecordedBookEvents = Schema.Struct({
  code: StockCode,
  recorded: Schema.Boolean,
  events: Schema.Array(BookEvent),
})
export type RecordedBookEvents = typeof RecordedBookEvents.Type

export const encodeRecordedBookEvents = Schema.encodeEffect(
  Schema.fromJsonString(RecordedBookEvents)
)
export const decodeRecordedBookEvents = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedBookEvents)
)

// The tape answer: ascending by trade number, like a snapshot's tape.
const RecordedTape = Schema.Struct({ trades: Schema.Array(RunningTrade) })

export const encodeRecordedTape = Schema.encodeEffect(
  Schema.fromJsonString(RecordedTape)
)
export const decodeRecordedTape = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedTape)
)

// The broker codes answer: the stored codes of the trades the tape answer at
// the same `at` holds, ascending by trade number, a trade with none absent;
// and whether the day's broker codes status is complete.
const RecordedBrokerCodes = Schema.Struct({
  codes: Schema.Array(Schema.Tuple([TradeNumber, TradeCodes])),
  complete: Schema.Boolean,
})
export type RecordedBrokerCodes = typeof RecordedBrokerCodes.Type

export const encodeRecordedBrokerCodes = Schema.encodeEffect(
  Schema.fromJsonString(RecordedBrokerCodes)
)
export const decodeRecordedBrokerCodes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedBrokerCodes)
)

// One broker on one side of a sweep: its code, the investor type it traded
// the most lots as in the sweep, its lots on that side, and, when it traded
// both types, how many of those lots were its minor type (the smaller).
const SweepBrokerFields = Schema.Struct({
  code: BrokerCode,
  investorType: InvestorType,
  lots: Schema.Finite,
  minorTypeLots: Schema.optionalKey(Schema.Finite),
})

// Decision: sweep brokers travel, and are stored, as tuples: an entry [first
// trade, pieces], a piece [sweep tuple, aggressor side, other side], a broker
// [code, investor type, lots, minor type's lots only when nonzero], not keyed
// objects: a busy code's 10–18 K sweeps a day answered 1–2 MB as tuples when
// an entry was [first trade, aggressor, other]. See apinrdw/kumora#343, #349.
//
// The stored rows decode only in these tuples' order, so a change to it, or
// to the sweep tuple's, needs a new SWEEP_BROKERS_SHAPE (dashboard
// day-store.ts) to rebuild them; an optional element appended at a tuple's
// end does not.
const SweepBroker = Schema.Tuple([
  BrokerCode,
  InvestorType,
  Schema.Finite,
  Schema.optionalKey(Schema.Finite),
]).pipe(
  Schema.decodeTo(Schema.toType(SweepBrokerFields), {
    decode: SchemaGetter.transform(
      ([code, investorType, lots, minorTypeLots]) => ({
        code,
        investorType,
        lots,
        ...(minorTypeLots === undefined ? {} : { minorTypeLots }),
      })
    ),
    encode: SchemaGetter.transform((broker) =>
      broker.minorTypeLots === undefined
        ? ([broker.code, broker.investorType, broker.lots] as const)
        : ([
            broker.code,
            broker.investorType,
            broker.lots,
            broker.minorTypeLots,
          ] as const)
    ),
  })
)
export type SweepBroker = typeof SweepBroker.Type

// An order run's aggressor orders: how many, the first and last order
// number, and the lots of its biggest passive order, summed over the run's
// trades.
const SweepOrdersFields = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  first: OrderNumber,
  last: OrderNumber,
  biggestPassiveLots: Schema.Finite,
})
export type SweepOrders = typeof SweepOrdersFields.Type

const SweepOrders = Schema.Tuple([
  SweepOrdersFields.fields.count,
  OrderNumber,
  OrderNumber,
  Schema.Finite,
]).pipe(
  Schema.decodeTo(Schema.toType(SweepOrdersFields), {
    decode: SchemaGetter.transform(
      ([count, first, last, biggestPassiveLots]) => ({
        count,
        first,
        last,
        biggestPassiveLots,
      })
    ),
    encode: SchemaGetter.transform(
      (orders) =>
        [
          orders.count,
          orders.first,
          orders.last,
          orders.biggestPassiveLots,
        ] as const
    ),
  })
)

// One piece of a whole sweep: one aggressor broker's trades of it, or one
// order run's, a sweep of their own (named by their first trade's number),
// with each side's brokers, largest lots first, and an order run's orders.
// A sided piece has one broker in `aggressor`; an auction match's one piece
// holds its buyers there and its sellers in `other`.
const SweepPieceFields = Schema.Struct({
  ...SweepFields.fields,
  aggressor: Schema.Array(Schema.toType(SweepBroker)),
  other: Schema.Array(Schema.toType(SweepBroker)),
  orders: Schema.optionalKey(Schema.toType(SweepOrders)),
})

// Decision: an order run's orders ride as an optional fourth element, after
// the sides, and a per-broker piece has none, so a row stored before them
// decodes as it is and SWEEP_BROKERS_SHAPE stays: no old day rebuilds. See
// spec apinrdw/kumora#627, "Slice 2".
const SweepPiece = Schema.Tuple([
  Sweep,
  Schema.Array(SweepBroker),
  Schema.Array(SweepBroker),
  Schema.optionalKey(SweepOrders),
]).pipe(
  Schema.decodeTo(Schema.toType(SweepPieceFields), {
    decode: SchemaGetter.transform(([sweep, aggressor, other, orders]) => ({
      ...sweep,
      aggressor,
      other,
      ...(orders === undefined ? {} : { orders }),
    })),
    encode: SchemaGetter.transform(({ aggressor, other, orders, ...sweep }) =>
      orders === undefined
        ? ([sweep, aggressor, other] as const)
        : ([sweep, aggressor, other, orders] as const)
    ),
  })
)
export type SweepPiece = typeof SweepPiece.Type

// One whole sweep or auction match, named by its first trade's number, and
// its pieces in trade order.
const SweepBrokersFields = Schema.Struct({
  firstTrade: TradeNumber,
  pieces: Schema.Array(Schema.toType(SweepPiece)),
})

const SweepBrokers = Schema.Tuple([TradeNumber, Schema.Array(SweepPiece)]).pipe(
  Schema.decodeTo(Schema.toType(SweepBrokersFields), {
    decode: SchemaGetter.transform(([firstTrade, pieces]) => ({
      firstTrade,
      pieces,
    })),
    encode: SchemaGetter.transform(
      (sweep) => [sweep.firstTrade, sweep.pieces] as const
    ),
  })
)
export type SweepBrokers = typeof SweepBrokers.Type

// The sweep brokers answer: every whole sweep and auction match of one code
// (one whose every trade has stored codes) with its pieces, in trade order,
// whether the day's broker codes status is complete, and whether the day
// still takes broker codes, so a later answer may differ. Never inside the
// sweeps answer, which a sealed day caches for a year.
const RecordedSweepBrokers = Schema.Struct({
  code: StockCode,
  sweeps: Schema.Array(SweepBrokers),
  complete: Schema.Boolean,
  // Decision: optional, read as false when absent: only a move stored an
  // answer without it, of a day that took no more codes, and a cold day's
  // answer is kept for good. See PR #632.
  takesCodes: Schema.optionalKey(Schema.Boolean),
})
export type RecordedSweepBrokers = typeof RecordedSweepBrokers.Type

export const encodeRecordedSweepBrokers = Schema.encodeEffect(
  Schema.fromJsonString(RecordedSweepBrokers)
)
export const decodeRecordedSweepBrokers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedSweepBrokers)
)

// A list of whole sweeps' brokers as JSON, as the answer's `sweeps` holds
// them: the trading-day object's sweep brokers row.
const SweepBrokersText = Schema.fromJsonString(Schema.Array(SweepBrokers))
export const encodeSweepBrokersText = Schema.encodeEffect(SweepBrokersText)
export const decodeSweepBrokersText =
  Schema.decodeUnknownEffect(SweepBrokersText)

// One code's candles and footprints for the whole day, each ascending by
// minute, and the previous close a `liveprice` frame carried, the
// watchlist's base at any cursor.
const RecordedCandles = Schema.Struct({
  code: StockCode,
  previousClose: Schema.optionalKey(Schema.Finite),
  candles: Schema.Array(Candle),
  // Decision: optional, read as none when absent. A sealed day's answer is
  // cached immutable for a year (SEALED_CACHE), so a browser can still hold
  // one sent before footprints were, and it must keep decoding. See spec
  // apinrdw/kumora#263.
  footprints: Schema.optionalKey(Schema.Array(Footprint)),
})
export type RecordedCandles = typeof RecordedCandles.Type

export const encodeRecordedCandles = Schema.encodeEffect(
  Schema.fromJsonString(RecordedCandles)
)
export const decodeRecordedCandles = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedCandles)
)

// The bubbles answer (spec apinrdw/kumora#427, "Backfill GET"): every stock
// code with a regular-board trade today, with its newest BUBBLE_MINUTES
// candles as [minute in epoch ms, value, volume, frequency, buy value, sell
// value, close], ascending; its day totals as [value, volume, frequency, buy
// value, sell value]; and the previous close a `liveprice` frame carried. Its
// last price is its newest minute's close (dashboard lib/bubbles.ts,
// `lastPrice`). Value is in rupiah, volume in lots. Tuples, as a busy day
// holds about 900 codes.
const BubbleMinute = Schema.Tuple([
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
])
const BubbleDay = Schema.Tuple([
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
])
const RecordedBubbles = Schema.Struct({
  // In epoch ms on the trading-day object's clock: the answer holds every
  // regular-board trade that reached the object before it (dashboard
  // candles.ts, `settledBefore`).
  settledBefore: Schema.Finite,
  codes: Schema.Array(
    Schema.Struct({
      code: StockCode,
      previousClose: Schema.optionalKey(Schema.Finite),
      day: BubbleDay,
      minutes: Schema.Array(BubbleMinute),
    })
  ),
})
export type RecordedBubbles = typeof RecordedBubbles.Type

// How many of a code's newest minutes the bubbles answer carries: the
// longest minute window, 1h, and the minute before it, whose close a code
// that traded every minute of the hour changes against.
export const BUBBLE_MINUTES = 61

// The Worker's flush, which also builds the bubbles answer (trading-day.ts
// `armFlush`).
// Decision: the day's state is written to the day store once a minute, 5 s
// past it, so each flush closes the minute's book chunks and 5 s merge
// windows; only the relay going offline (`ingestClosed`) flushes at once. A
// failed flush's payload rides the next, so a candle is never stored without
// its trades. See apinrdw/kumora#138 and apinrdw/kumora#157.
export const FLUSH_PAST_MINUTE = 5_000

export const encodeRecordedBubbles = Schema.encodeEffect(
  Schema.fromJsonString(RecordedBubbles)
)
export const decodeRecordedBubbles = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedBubbles)
)

const RecordedGaps = Schema.Struct({ gaps: Schema.Array(RelayGap) })

export const encodeRecordedGaps = Schema.encodeEffect(
  Schema.fromJsonString(RecordedGaps)
)
export const decodeRecordedGaps = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedGaps)
)

// One served order book frame after the one before it: when the trading-day
// Durable Object served it, the book's as-of, and the other parts that
// changed. The first frame of a code's day carries every part.
// Decision: the served instant is the replay's timeline, not the as-of: a
// served book can be older than the one before it (Ajaib's when Stockbit goes
// stale), and a replay cursor is an instant on the viewers' clock.
// See apinrdw/kumora#157.
const BookDelta = Schema.Struct({
  servedAt: Schema.DateTimeUtcFromMillis,
  at: Schema.DateTimeUtcFromMillis,
  // Decision: a frame carries all its book's per-side times and sequence
  // numbers, changed or not, and replay replaces them as one group, so a book
  // without one (Ajaib's sequences) never inherits the frame before's. An
  // older chunk has none and replays unchanged. See apinrdw/kumora#517.
  ...BookSideFields,
  provenance: Schema.optionalKey(Schema.Literals(["Stockbit", "Ajaib"])),
  bids: Schema.optionalKey(Schema.Array(BookLevel)),
  offers: Schema.optionalKey(Schema.Array(BookLevel)),
  bidLots: Schema.optionalKey(Schema.Finite),
  offerLots: Schema.optionalKey(Schema.Finite),
  previousClose: Schema.optionalKey(Schema.Finite),
})
export type BookDelta = typeof BookDelta.Type

// One code's order book over one minute (spec apinrdw/kumora#138, "Storage
// and cost"): the book in force when the minute began, absent before the
// code's first book, then every served frame in the minute, oldest first.
const BookChunk = Schema.Struct({
  code: StockCode,
  minute: Schema.DateTimeUtcFromMillis,
  start: Schema.optionalKey(OrderBook),
  deltas: Schema.Array(BookDelta),
})
export type BookChunk = typeof BookChunk.Type

export const encodeBookChunk = Schema.encodeEffect(
  Schema.fromJsonString(BookChunk)
)
export const decodeBookChunk = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BookChunk)
)

// The frame in force at `cursor`: the chunk's start with every frame served
// at or before the cursor applied. Undefined before the code's first book.
export const bookAt = (chunk: BookChunk, cursor: DateTime.Utc) =>
  Effect.sync(() => {
    let book = chunk.start
    for (const { servedAt, ...parts } of chunk.deltas) {
      if (DateTime.isGreaterThan(servedAt, cursor)) break
      // A first frame carries every part.
      const {
        bidAt: _bidAt,
        offerAt: _offerAt,
        bidSequence: _bidSequence,
        offerSequence: _offerSequence,
        ...before
      }: OrderBook = book ?? {
        _tag: "OrderBook",
        code: chunk.code,
        bids: [],
        offers: [],
        bidLots: 0,
        offerLots: 0,
        at: parts.at,
        provenance: "Stockbit",
      }
      book = { ...before, ...parts }
    }
    return book
  })

// One sealed day in the strip: IHSG's close and change when the day had an
// IHSG frame whose change was known (an index's frames carry no previous
// close, so one with neither a change nor a previous close records nothing),
// how many trades it recorded, whether it had a relay gap, and whether it is
// a cold day, its answers in R2: absent while it is hot. The day index sets
// `cold` in SQL as it reads the strip (`strip` in
// apps/dashboard/src/server/market-live/day-index.ts).
const RecordedDay = Schema.Struct({
  day: WibDate,
  ihsg: Schema.optionalKey(
    Schema.Struct({
      close: Schema.Finite,
      change: Schema.Finite,
      changePercent: Schema.Finite,
    })
  ),
  trades: Schema.Int,
  gap: Schema.Boolean,
  cold: Schema.optionalKey(Schema.Literal(true)),
})
export type RecordedDay = typeof RecordedDay.Type

export const encodeRecordedDay = Schema.encodeEffect(
  Schema.fromJsonString(RecordedDay)
)
export const decodeRecordedDay = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedDay)
)

const DayStrip = Schema.Struct({ days: Schema.Array(RecordedDay) })

export const decodeDayStrip = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DayStrip)
)
