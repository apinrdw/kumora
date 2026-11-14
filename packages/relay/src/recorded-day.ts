// Recorded day loads (spec apinrdw/kumora#138, "Recorded day loads" and
// "Seal and the index Durable Object"): plain GETs under `/market-live/days/*`,
// each answered by the named day's trading-day Durable Object, and the day
// strip, answered by the index Durable Object. The Worker entry reads a path
// back with `recordedDayRequest`; the page builds it with `recordedDayPath`.
import { DateTime, Effect, Option, Schema } from "effect"

import { StockCode } from "./codes.ts"
import {
  Candle,
  Footprint,
  RunningTrade,
  ViewerProtocolVersion,
} from "./envelope.ts"
import { RelayGap } from "./market-conditions.ts"
import { BookLevel, OrderBook } from "./order-book.ts"
import { WibDate } from "./schedule.ts"

const DAYS = "/market-live/days"

// The day strip: every sealed day, newest first.
export const DayStripPath = DAYS

// What one recorded day GET asks its day's object for.
export type RecordedResource =
  // The day's stock code list.
  | { readonly _tag: "Codes" }
  // The 200 newest running trades at or before `at`.
  | { readonly _tag: "Tape"; readonly at: DateTime.Utc }
  // One code's whole-day candles and its previous close.
  | { readonly _tag: "Candles"; readonly code: StockCode }
  // One code's sweeps for the day so far (sweeps.ts).
  | { readonly _tag: "Sweeps"; readonly code: StockCode }
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

export const recordedDayPath = (date: WibDate, resource: RecordedResource) =>
  Effect.sync(() => {
    const base = `${DAYS}/${date}`
    switch (resource._tag) {
      case "Codes":
        return `${base}/codes`
      case "Tape":
        return `${base}/trades?at=${DateTime.toEpochMillis(resource.at)}`
      // Decision: the candles path carries the viewer protocol's version. A
      // sealed answer is cached for a year (SEALED_CACHE), and the browser
      // keys its cache on the whole URL, so an answer cached before
      // footprints rode with the candles is never reused: a day recorded
      // before order flow shipped still shows its footprint. A later change
      // to the answer comes with a protocol bump, so it moves the path too.
      // The query is ignored when read, so a tab on an older build still
      // loads. See spec apinrdw/kumora#263, ticket apinrdw/kumora#270.
      case "Candles":
        return `${base}/candles/${resource.code}?v=${ViewerProtocolVersion}`
      case "Sweeps":
        return `${base}/sweeps/${resource.code}`
      case "Book":
        return `${base}/books/${resource.code}?minute=${DateTime.toEpochMillis(resource.minute)}`
      case "Gaps":
        return `${base}/gaps`
      case "Heatmap":
        return `${base}/heatmap/${resource.code}`
    }
  })

// The day's stock code list path; the page fetches it.
export const stockCodeListPath = (date: WibDate) =>
  recordedDayPath(date, { _tag: "Codes" })

const decodeDate = Schema.decodeUnknownOption(WibDate)
const decodeCode = Schema.decodeUnknownOption(StockCode)

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

const resourceOf = Effect.fnUntraced(function* (
  parts: ReadonlyArray<string>,
  search: ReadonlyMap<string, string>
): Effect.fn.Return<Option.Option<RecordedResource>> {
  const [kind, code, ...rest] = parts
  if (rest.length > 0) return Option.none()
  if (code === undefined) {
    if (kind === "codes") return Option.some({ _tag: "Codes" })
    if (kind === "gaps") return Option.some({ _tag: "Gaps" })
    if (kind === "trades")
      return Option.map(yield* instantOf(search.get("at")), (at) => ({
        _tag: "Tape" as const,
        at,
      }))
    return Option.none()
  }
  if (kind === "candles")
    return Option.map(decodeCode(code), (stock) => ({
      _tag: "Candles" as const,
      code: stock,
    }))
  if (kind === "heatmap")
    return Option.map(decodeCode(code), (stock) => ({
      _tag: "Heatmap" as const,
      code: stock,
    }))
  if (kind === "sweeps")
    return Option.map(decodeCode(code), (stock) => ({
      _tag: "Sweeps" as const,
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

// The tape answer: ascending by trade number, like a snapshot's tape.
const RecordedTape = Schema.Struct({ trades: Schema.Array(RunningTrade) })

export const encodeRecordedTape = Schema.encodeEffect(
  Schema.fromJsonString(RecordedTape)
)
export const decodeRecordedTape = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedTape)
)

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
      const before: OrderBook = book ?? {
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
// how many trades it recorded, and whether it had a relay gap.
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
