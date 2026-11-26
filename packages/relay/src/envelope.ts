import { Effect, Option, Order, Schema, SchemaGetter } from "effect"

import { BookEvent } from "./book-events.ts"
import { OrderFlowEvent } from "./order-flow-events.ts"
import { BookReadings } from "./book-readings.ts"
import { StockCode } from "./codes.ts"
import { IndicativePrice, MarketConditions } from "./market-conditions.ts"
import { DayState } from "./day-state.ts"
import { IndexHasNoBook, OrderBook } from "./order-book.ts"
import { ScannerFigures } from "./scanner-figures.ts"
import type { WibDate } from "./schedule.ts"

// Bump on any change to an ingest message's shape. The dashboard accepts this
// version and the one before it, so an extension one release behind keeps
// relaying while the owner reloads it.
export const IngestProtocolVersion = 1
const acceptedIngestVersions: ReadonlyArray<unknown> = [
  IngestProtocolVersion,
  IngestProtocolVersion - 1,
]

// Bump on any change to a viewer message's shape. Only this version is
// accepted: a page on another version reloads.
// 2: market conditions carry delayed freshness and each delayed feed's lag.
// 3: snapshots and deltas carry footprints, and deltas a selected code's
// sweeps by minute (spec apinrdw/kumora#263).
// 4: a trade's feeds may list `walk` (spec apinrdw/kumora#437).
// 5: candles carry their buy value and sell value, and snapshots and deltas
// the instant they were sent (spec apinrdw/kumora#427).
// 6: deltas and snapshots carry sweep alerts (spec apinrdw/kumora#510).
// 7: deltas carry whole order books only for selected codes and every
// changed code's book readings and the book events found since the last;
// snapshots carry every code's readings, scanner figures and the latest book
// events (spec apinrdw/kumora#517).
// 8: book readings drop near depth, empty ticks and the spread (spec
// apinrdw/kumora#605).
// 9: snapshots and deltas carry order flow events (spec apinrdw/kumora#605).
// 10: deltas carry standout sweeps (spec apinrdw/kumora#705).
// 11: snapshots carry the day's standout sweeps (spec apinrdw/kumora#705).
export const ViewerProtocolVersion = 11

// Decision: 4403 refuses the token, 4426 a protocol; both stop ingest retries
// (packages/relay/docs/adr/0003-ingest-socket-closes-4403-and-4426-stop-retries.md)
//
// 4403 and 4426 stop the relay retrying (apps/extension target.ts); 4408, a
// socket closed without its token within the trading-day object's deadline,
// reconnects like a dropped one.
export const IngestCloseCode = {
  RejectedToken: 4403,
  TokenOverdue: 4408,
  VersionMismatch: 4426,
} as const

// 4401 and 4426 are terminal for the page. 1011, a Select the trading-day
// object couldn't serve, and 1001, the object's day over, reconnect like any
// other close and resume from a fresh snapshot.
export const ViewerCloseCode = {
  SignInRequired: 4401,
  NewVersion: 4426,
  SelectNotServed: 1011,
  DayEnded: 1001,
} as const

// Where the dashboard Worker serves the two sockets. The extension opens the
// ingest socket; the Market Live page opens the viewer socket.
export const MarketLivePath = {
  ingest: "/market-live/ingest",
  live: "/market-live/live",
} as const

export const Feed = Schema.Literals(["Stockbit", "Ajaib"])
export type Feed = typeof Feed.Type

export const Connection = Schema.Literals(["A", "B"])
export type Connection = typeof Connection.Type

// Decision: a trade number travels as a string of digits, not a JSON number
// (packages/relay/docs/adr/0019-a-trade-number-travels-as-a-string-of-digits.md)
export const TradeNumber = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
  Schema.brand("TradeNumber")
)
export type TradeNumber = typeof TradeNumber.Type

// Trade numbers in their numeric order. Strings of different lengths compare
// wrongly as text, so they compare as BigInt.
export const TradeNumberOrder: Order.Order<TradeNumber> = Order.mapInput(
  Order.BigInt,
  BigInt
)

// A trade number as a bigint, for the arithmetic a range of them needs: the
// extension's backfill walks, merges and pages ranges by it, and the
// dashboard's gap detection and day store compare by it.
export const TradeNumberValue = Schema.BigInt.pipe(
  Schema.brand("TradeNumberValue")
)
export type TradeNumberValue = typeof TradeNumberValue.Type
export const tradeNumberValue = (number: TradeNumber) =>
  Effect.sync(() => TradeNumberValue.make(BigInt(number)))

// Ajaib's number for a trade, in its trade frames and REST pages: the WIB
// date, `YYYYMMDD`, and the day's 10-digit sequence. The tape's trade number
// is the bare sequence, the one Stockbit sends.
export const AjaibTradeNum = Schema.String.check(Schema.isPattern(/^\d{18}$/))
export type AjaibTradeNum = typeof AjaibTradeNum.Type
const AJAIB_DATE_LENGTH = 8

// The tape's trade number of an Ajaib trade number, whatever its date.
export const ajaibSequence = (tradeNum: AjaibTradeNum) =>
  Effect.sync(() =>
    TradeNumber.make(BigInt(tradeNum.slice(AJAIB_DATE_LENGTH)).toString())
  )

// The tape's trade number of an Ajaib trade number when it is `date`'s; none
// for another day's, which a page or a frame near midnight can carry.
export const ajaibTradeNumber = (date: WibDate, tradeNum: AjaibTradeNum) =>
  Effect.map(ajaibSequence(tradeNum), (tradeNumber) =>
    tradeNum.startsWith(date.replaceAll("-", ""))
      ? Option.some(tradeNumber)
      : Option.none()
  )

const versioned = { protocolVersion: Schema.Int }
const fromConnection = {
  ...versioned,
  connection: Connection,
  receivedAt: Schema.DateTimeUtcFromMillis,
}

// One connection's raw frames from about 250 ms, unparsed: Stockbit's protobuf
// bytes (base64 on the wire) or Ajaib's JSON text.
export const StockbitFrames = Schema.TaggedStruct("Frames", {
  ...fromConnection,
  feed: Schema.Literal("Stockbit"),
  frames: Schema.Array(Schema.Uint8ArrayFromBase64),
})
// Which of Ajaib's sockets an envelope's frames came from: the trade tape,
// whose frames are the feed's signs of life, or an on-demand stream (price,
// indicative or order book), whose frames answer a subscription and say
// nothing about the tape.
const FrameStream = Schema.Literals(["trade", "on-demand"])
export type FrameStream = typeof FrameStream.Type

export const AjaibFrames = Schema.TaggedStruct("Frames", {
  ...fromConnection,
  feed: Schema.Literal("Ajaib"),
  stream: FrameStream,
  frames: Schema.Array(Schema.String),
})

// Decision: an ingest socket's first message past the cap closes 4403 unread
// (packages/relay/docs/adr/0020-an-ingest-socket-s-first-message-is-capped.md)
export const INGEST_TOKEN_MESSAGE_LIMIT = 1024

// The ingest token, the first message after the socket opens.
export const IngestToken = Schema.TaggedStruct("Token", {
  ...versioned,
  token: Schema.String,
})

// Ajaib's stock code list, sent once a day as the raw response body.
export const CodeList = Schema.TaggedStruct("CodeList", {
  ...versioned,
  receivedAt: Schema.DateTimeUtcFromMillis,
  body: Schema.String,
})

// A connection opened, closed, or answered a ping (a sign of life).
export const FeedStatus = Schema.TaggedStruct("FeedStatus", {
  ...versioned,
  feed: Feed,
  connection: Connection,
  at: Schema.DateTimeUtcFromMillis,
  status: Schema.Literals(["opened", "closed", "alive"]),
})

// One REST page of a broker's running-trade tape, fetched to answer a
// Backfill, as the raw response body: the Worker decodes it, as it does the
// sockets' frames. `from` and `to` are the numbers the page was fetched for;
// the object keeps only the rows between them.
const BackfillPage = Schema.TaggedStruct("BackfillPage", {
  ...versioned,
  feed: Feed,
  receivedAt: Schema.DateTimeUtcFromMillis,
  from: TradeNumber,
  to: TradeNumber,
  body: Schema.String,
})
export type BackfillPage = typeof BackfillPage.Type

// Extension → trading-day Durable Object.
const IngestUp = Schema.Union([
  IngestToken,
  StockbitFrames,
  AjaibFrames,
  CodeList,
  FeedStatus,
  BackfillPage,
])
export type IngestUp = typeof IngestUp.Type

// Fetch the trades numbered from `from` to `to`, inclusive. `nextTime` is
// when trade `to` + 1, the first after the gap, happened: Ajaib's REST tape
// has no trade-number filter and pages back from a time.
export const Backfill = Schema.TaggedStruct("Backfill", {
  from: TradeNumber,
  to: TradeNumber,
  nextTime: Schema.DateTimeUtcFromMillis,
})

// The codes to keep subscribed on Ajaib: every code a viewer has selected or
// in a watchlist. A code this message newly names for its socket is
// subscribed afresh, so the object gets Ajaib's whole book of it even when
// the relay's other target already holds the code.
export const OnDemandCodes = Schema.TaggedStruct("OnDemandCodes", {
  codes: Schema.Array(StockCode),
})

// Trading-day Durable Object → extension.
const IngestDown = Schema.Union([Backfill, OnDemandCodes])
export type IngestDown = typeof IngestDown.Type

// Decision: a watchlist holds at most 10,000 codes, kept in object storage
// (packages/relay/docs/adr/0010-a-viewer-s-watchlist-is-capped-and-stored-outside-the-socket.md)
const WATCHLIST_LIMIT = 10_000

// Decision: a watchlist holds at most 10,000 codes, kept in object storage
// (packages/relay/docs/adr/0010-a-viewer-s-watchlist-is-capped-and-stored-outside-the-socket.md)
export const VIEWER_MESSAGE_LIMIT = 200_000

// The page's selected code and watchlist, sent on open and on every change.
export const Select = Schema.TaggedStruct("Select", {
  ...versioned,
  selected: StockCode,
  watchlist: Schema.Array(StockCode).check(Schema.isMaxLength(WATCHLIST_LIMIT)),
})

// Page → dashboard Worker.
export type ViewerUp = typeof Select.Type

// Who took the aggressor side. Auction matches and negotiated prints have none.
// Decision: tape chunks hold 32-byte records; Side, Board, feeds are indexes
// (packages/relay/docs/adr/0006-tape-chunks-hold-fixed-32-byte-records-with-append-only-enums.md)
export const Side = Schema.Literals(["buy", "sell", "none"])

// The market board: regular, cash (tunai), or negotiated.
export const Board = Schema.Literals(["RG", "TN", "NG"])

// A trade frame without `market_type` is on the regular board. The
// 2026-11-09 probe saw no `market_type` on any of 44,360 TRADE frames, all
// regular-board stocks; an unknown value is read the same way until a capture
// shows the cash and negotiated boards' frames.
// Ajaib's `market_type` and Stockbit's REST `market_board` both read this way.
export const boardOf = (marketType: string | undefined) =>
  Effect.succeed<typeof Board.Type>(
    marketType === "TN" || marketType === "NG" ? marketType : "RG"
  )

// A number Stockbit's REST tape sends comma-grouped, such as "2,300"; NaN
// when it isn't one.
export const groupedNumber = (text: string) =>
  Effect.succeed(Number(text.replaceAll(",", "")))

// Where a running trade was seen: a live feed, a backfill request's answer,
// or a walk after the close, on a day whose tape source is the walks.
// Append-only, as Side is.
export const TradeSource = Schema.Literals([
  "Stockbit",
  "Ajaib",
  "backfill",
  "walk",
])

// One trade on the whole-market tape, merged across feeds. Its trade number is
// the bare daily sequence, one market-wide numbering per trading day. Value is
// price × lots × SHARES_PER_LOT, so it does not travel.
export const RunningTrade = Schema.Struct({
  tradeNumber: TradeNumber,
  time: Schema.DateTimeUtcFromMillis,
  code: StockCode,
  price: Schema.Int,
  // Not always whole: a negotiated print can be an odd lot (Stockbit sends 50
  // shares as 0.5 lot).
  lots: Schema.Finite,
  side: Side,
  board: Board,
  feeds: Schema.Array(TradeSource),
})
export type RunningTrade = typeof RunningTrade.Type

// A candle's span in ms: one minute. Every module that floors an instant to
// its minute, or steps a minute, uses this one.
export const MINUTE_MS = 60_000

// One stock code's or index's 1-minute candle. A stock's is built from its
// regular-board trades: volume in lots, value in rupiah, frequency in trades.
// An index's is built from its `liveprice` frames, its volume, value and
// frequency the market's over that minute. Its buy value and sell value are
// the rupiah value of its trades whose aggressor side is buy, and of those
// whose side is sell; a trade with no side counts toward `value` only. An
// index's are 0.
export const Candle = Schema.Struct({
  code: StockCode,
  // The minute's start.
  minute: Schema.DateTimeUtcFromMillis,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  close: Schema.Finite,
  volume: Schema.Finite,
  value: Schema.Finite,
  buyValue: Schema.Finite,
  sellValue: Schema.Finite,
  frequency: Schema.Int,
})
export type Candle = typeof Candle.Type

// One price of a footprint: the lots traded there by sell aggressors, by buy
// aggressors, and with no aggressor side (auction matches).
const FootprintCell = Schema.Struct({
  price: Schema.Int,
  sell: Schema.Finite,
  buy: Schema.Finite,
  none: Schema.Finite,
})
export type FootprintCell = typeof FootprintCell.Type

// One stock code's footprint for one minute: its regular-board trades' lots
// by price and aggressor side, the same trades as its candle. Cells ascend by
// price. An index has none.
export const Footprint = Schema.Struct({
  code: StockCode,
  // The minute's start.
  minute: Schema.DateTimeUtcFromMillis,
  cells: Schema.Array(FootprintCell),
})
export type Footprint = typeof Footprint.Type

// One sweep (the rule is in sweeps.ts): its aggressor side, its first trade's
// number and time, its first and last price, and its lots, value and trade
// count. A trade is in one sweep, so its first trade's number names a sweep
// for the day, however a late trade regroups the sweeps around it. Side
// `none` is an auction match's prints in one second: no aggressor, so no
// sweep, but the sweep log shows it as one neutral row.
export const SweepFields = Schema.Struct({
  side: Side,
  firstTrade: TradeNumber,
  time: Schema.DateTimeUtc,
  first: Schema.Int,
  last: Schema.Int,
  lots: Schema.Finite,
  value: Schema.Finite,
  trades: Schema.Int,
})

// Decision: footprint cells and sweeps are tuples, not keyed objects
// (packages/relay/docs/adr/0007-footprint-cells-and-sweeps-are-tuples-on-the-wire-and-in-storage.md)
//
// A footprint row (dashboard sweep-rows.ts) and a sweep brokers piece
// (recorded-day.ts) store the same order; change all three. A stored sweep
// brokers row decodes only in its own order, so a change also needs a new
// SWEEP_BROKERS_SHAPE (dashboard day-store.ts) to rebuild the stored rows.
export const Sweep = Schema.Tuple([
  Side,
  TradeNumber,
  Schema.DateTimeUtcFromMillis,
  Schema.Int,
  Schema.Int,
  Schema.Finite,
  Schema.Finite,
  Schema.Int,
]).pipe(
  Schema.decodeTo(Schema.toType(SweepFields), {
    decode: SchemaGetter.transform(
      ([side, firstTrade, time, first, last, lots, value, trades]) => ({
        side,
        firstTrade,
        time,
        first,
        last,
        lots,
        value,
        trades,
      })
    ),
    encode: SchemaGetter.transform(
      (sweep) =>
        [
          sweep.side,
          sweep.firstTrade,
          sweep.time,
          sweep.first,
          sweep.last,
          sweep.lots,
          sweep.value,
          sweep.trades,
        ] as const
    ),
  })
)
export type Sweep = typeof Sweep.Type

// One stock code's sweeps in one minute, whole and in trade order: none once
// its last regular-board trade left the minute.
const MinuteSweeps = Schema.Struct({
  code: StockCode,
  // The minute's start.
  minute: Schema.DateTimeUtcFromMillis,
  sweeps: Schema.Array(Sweep),
})
export type MinuteSweeps = typeof MinuteSweeps.Type

// A sweep alert's side: an auction match's sweep has none and never alerts.
const AlertSide = Schema.Literals(["buy", "sell"])
export type AlertSide = typeof AlertSide.Type

// A sweep that reached its stock code's top-1% cutoff for its side (the rule
// is in the dashboard's sweep-alerts.ts): its code, side and lots, and the
// trade numbers of its trades, which the page marks on the tape.
const SweepAlert = Schema.Struct({
  code: StockCode,
  side: AlertSide,
  lots: Schema.Finite,
  tradeNumbers: Schema.Array(TradeNumber),
})
export type SweepAlert = typeof SweepAlert.Type

// The top-N% cutoffs a sweep can stand out at, smallest first: a standout
// sweep's level is the first it reaches.
export const STANDOUT_LEVELS = [1, 5, 10] as const

// The smallest top-N% of its side's sweeps a standout sweep reached.
const StandoutLevel = Schema.Literals(STANDOUT_LEVELS)
export type StandoutLevel = typeof StandoutLevel.Type

// A sweep that reached its stock code's top-1%, 5% or 10% cutoff for its
// side (the rule is in the dashboard's sweep-alerts.ts), as the sweep was
// when decided: a later regroup that grows it doesn't send it again. Its
// code and first trade's number name it for the day.
const StandoutSweep = Schema.Struct({
  code: StockCode,
  level: StandoutLevel,
  sweep: Sweep,
})
export type StandoutSweep = typeof StandoutSweep.Type

// When the trading-day object sent a message, on its clock: what the
// message holds came from the trades that reached it before then. Market
// Bubbles takes a backfill settled past it as holding them too
// (apps/dashboard/src/lib/bubbles.ts, `applyBubbles`).
const SentAt = Schema.DateTimeUtcFromMillis

// What a viewer starts from after each Select: the 200 newest running trades,
// ascending by trade number, and the selected code's candles and footprints
// so far, ascending by minute. The selected code's order book once it has one, or
// word that it is an index.
const Snapshot = Schema.TaggedStruct("Snapshot", {
  at: SentAt,
  // The code the Select it answers selected. A snapshot answering an earlier
  // Select can arrive after the page moved to another code, so the chart and
  // the order book take only a snapshot of their own code.
  selected: StockCode,
  tape: Schema.Array(RunningTrade),
  candles: Schema.Array(Candle),
  footprints: Schema.Array(Footprint),
  // The selected and watchlist codes' that have figures; a code missing has
  // none yet. Absent when none has.
  dayStates: Schema.optionalKey(Schema.Array(DayState)),
  orderBook: Schema.optionalKey(Schema.Union([OrderBook, IndexHasNoBook])),
  conditions: MarketConditions,
  // The selected and watchlist codes' that have one, so the watchlist shows
  // them during an auction. Absent when none has.
  indicative: Schema.optionalKey(Schema.Array(IndicativePrice)),
  // The day's sweep alerts with a trade on this tape, which the page marks
  // and never plays. Absent when none has.
  sweepAlerts: Schema.optionalKey(Schema.Array(SweepAlert)),
  // The day's standout sweeps of every code the object decided since it
  // started, newest first, the newest STANDOUTS_PER_LEVEL
  // (standout-sweeps.ts) at or under each level. Absent when there are none.
  standoutSweeps: Schema.optionalKey(Schema.Array(StandoutSweep)),
  // Every code's latest book readings. Absent when no code has any yet.
  bookReadings: Schema.optionalKey(Schema.Array(BookReadings)),
  // The scanner's figures of every code with readings: its last price,
  // previous close, regular-board value today and previous trading day's
  // value. Absent when no code has readings yet.
  scannerFigures: Schema.optionalKey(Schema.Array(ScannerFigures)),
  // The day's newest SNAPSHOT_BOOK_EVENTS (book-events.ts) book events of every code, oldest
  // first. Absent when there are none.
  bookEvents: Schema.optionalKey(Schema.Array(BookEvent)),
  // The selected code's newest MAX_CODE_BOOK_EVENTS (book-events.ts) book
  // events of the day, oldest first. Absent when it has none.
  selectedBookEvents: Schema.optionalKey(Schema.Array(BookEvent)),
  // The day's newest SNAPSHOT_ORDER_FLOW_EVENTS (order-flow-events.ts) order
  // flow events of every code, oldest first. Absent when there are none.
  orderFlowEvents: Schema.optionalKey(Schema.Array(OrderFlowEvent)),
  // The selected code's newest MAX_CODE_ORDER_FLOW_EVENTS order flow events
  // of the day, oldest first. Absent when it has none.
  selectedOrderFlowEvents: Schema.optionalKey(Schema.Array(OrderFlowEvent)),
})

// The running trades that arrived in the last ~250 ms, ascending by trade
// number. A late trade sorts below ones the viewer already holds. Candles are
// every candle that changed since the last delta, of any code, each whole: the
// page keeps its selected code's.
const Delta = Schema.TaggedStruct("Delta", {
  at: SentAt,
  tape: Schema.Array(RunningTrade),
  candles: Schema.Array(Candle),
  // Every footprint that changed since the last delta of a code some viewer
  // selected, each whole. One with no cells, sent without its minute's
  // candle, says the minute's last regular-board trade left it; that one
  // goes out for any code. Absent when none changed. What the pages do with
  // one is in apps/dashboard/src/components/market-live/candle-store.ts and
  // apps/dashboard/src/lib/bubbles.ts.
  footprints: Schema.optionalKey(Schema.Array(Footprint)),
  // Every minute whose sweeps a trade changed since the last delta, of a
  // code some viewer selected, each whole: the page replaces its copy of
  // that minute (candles.ts, `takeChanged`). Absent when none changed.
  sweeps: Schema.optionalKey(Schema.Array(MinuteSweeps)),
  // The sweeps of any code that alerted since the last delta, each decided
  // once its second closed. Absent when none did.
  sweepAlerts: Schema.optionalKey(Schema.Array(SweepAlert)),
  // The sweeps of any code that stood out since the last delta, in the order
  // decided, each once. A sweep alert is one at level 1. Absent when none
  // did.
  standoutSweeps: Schema.optionalKey(Schema.Array(StandoutSweep)),
  // Every changed Day state of a code some viewer selected or watches, each
  // whole. Absent when none changed.
  dayStates: Schema.optionalKey(Schema.Array(DayState)),
  // Every served book that changed since the last delta of a code some
  // viewer selected, each whole: the page reads only its selected code's.
  // Absent when none changed.
  orderBooks: Schema.optionalKey(Schema.Array(OrderBook)),
  // The readings of every code whose served book changed since the last
  // delta, whatever each viewer selected, taken only in Sessions 1 and 2.
  // Absent when none changed.
  bookReadings: Schema.optionalKey(Schema.Array(BookReadings)),
  // The scanner's figures of every code with readings whose figures differ
  // from what the viewers were last sent. Absent when none does.
  scannerFigures: Schema.optionalKey(Schema.Array(ScannerFigures)),
  // The book events of every code found since the last delta, oldest first.
  // Absent when none was.
  bookEvents: Schema.optionalKey(Schema.Array(BookEvent)),
  // The order flow events of every code found since the last delta, oldest
  // first. Absent when none was.
  orderFlowEvents: Schema.optionalKey(Schema.Array(OrderFlowEvent)),
  // Present only when they changed.
  conditions: Schema.optionalKey(MarketConditions),
  // Every code's that changed, whatever each viewer selected.
  indicative: Schema.optionalKey(Schema.Array(IndicativePrice)),
})

// Trading-day Durable Object → page. It carries no version: the page's
// version is checked on its Select, and a mismatch closes the socket.
const ViewerDown = Schema.Union([Snapshot, Delta])
export type ViewerDown = typeof ViewerDown.Type

export class ProtocolVersionMismatch extends Schema.TaggedError<ProtocolVersionMismatch>()(
  "ProtocolVersionMismatch",
  {
    protocol: Schema.Literals(["ingest", "viewer"]),
    received: Schema.Unknown,
    closeCode: Schema.Literal(4426),
  }
) {}

const Json = Schema.fromJsonString(Schema.Unknown)
const VersionProbe = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.Unknown),
})

// Parses a message's JSON and fails with ProtocolVersionMismatch unless its
// version is accepted, before its shape is checked: a message from another
// version may not decode at all.
const versionChecked = Effect.fnUntraced(function* (
  text: string,
  protocol: "ingest" | "viewer",
  accepted: ReadonlyArray<unknown>
) {
  const json = yield* Schema.decodeUnknownEffect(Json)(text)
  const { protocolVersion } =
    yield* Schema.decodeUnknownEffect(VersionProbe)(json)
  if (!accepted.includes(protocolVersion)) {
    return yield* new ProtocolVersionMismatch({
      protocol,
      received: protocolVersion,
      closeCode:
        protocol === "ingest"
          ? IngestCloseCode.VersionMismatch
          : ViewerCloseCode.NewVersion,
    })
  }
  return json
})

export const decodeIngestUp = Effect.fnUntraced(function* (text: string) {
  const json = yield* versionChecked(text, "ingest", acceptedIngestVersions)
  return yield* Schema.decodeUnknownEffect(IngestUp)(json)
})

// An ingest envelope as the socket carries it, from `encodeIngestUp` only.
export const EncodedIngestUp = Schema.String.pipe(
  Schema.brand("EncodedIngestUp")
)
export type EncodedIngestUp = typeof EncodedIngestUp.Type

const encodeIngestUpText = Schema.encodeEffect(Schema.fromJsonString(IngestUp))

export const encodeIngestUp = Effect.fnUntraced(function* (message: IngestUp) {
  return EncodedIngestUp.make(yield* encodeIngestUpText(message))
})

export const decodeIngestDown = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IngestDown)
)

export const encodeIngestDown = Schema.encodeEffect(
  Schema.fromJsonString(IngestDown)
)

export const decodeViewerUp = Effect.fnUntraced(function* (text: string) {
  const json = yield* versionChecked(text, "viewer", [ViewerProtocolVersion])
  return yield* Schema.decodeUnknownEffect(Select)(json)
})

export const encodeViewerUp = Schema.encodeEffect(Schema.fromJsonString(Select))

export const decodeViewerDown = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ViewerDown)
)

export const encodeViewerDown = Schema.encodeEffect(
  Schema.fromJsonString(ViewerDown)
)
