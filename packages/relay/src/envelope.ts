import { Effect, Order, Schema } from "effect"

import { StockCode } from "./codes.ts"
import { IndicativePrice, MarketStatus } from "./market-status.ts"
import { DayState } from "./day-state.ts"
import { IndexHasNoBook, OrderBook } from "./order-book.ts"

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
export const ViewerProtocolVersion = 1

// Decision: an extension that hits either code stops retrying that target and
// shows it; any other close, 1006 included, retries with backoff. The token
// travels as the first message because a browser websocket can't set headers.
// See apinrdw/kumora#45.
export const IngestCloseCode = {
  RejectedToken: 4403,
  VersionMismatch: 4426,
} as const

// Both are terminal for the page; any other close reconnects and resumes from
// a fresh snapshot.
export const ViewerCloseCode = {
  SignInRequired: 4401,
  NewVersion: 4426,
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

// Decision: a trade number travels as a string of digits. The date-prefixed
// form (YYYYMMDD plus the sequence) exceeds 2^53, so a JSON number would lose
// digits. See apinrdw/kumora#45.
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
export const AjaibFrames = Schema.TaggedStruct("Frames", {
  ...fromConnection,
  feed: Schema.Literal("Ajaib"),
  frames: Schema.Array(Schema.String),
})

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
// in a watchlist.
export const OnDemandCodes = Schema.TaggedStruct("OnDemandCodes", {
  codes: Schema.Array(StockCode),
})

// Trading-day Durable Object → extension.
const IngestDown = Schema.Union([Backfill, OnDemandCodes])
export type IngestDown = typeof IngestDown.Type

// The page's selected code and watchlist, sent on open and on every change.
export const Select = Schema.TaggedStruct("Select", {
  ...versioned,
  selected: StockCode,
  watchlist: Schema.Array(StockCode),
})

// Page → dashboard Worker.
export type ViewerUp = typeof Select.Type

// Who took the aggressor side. Auction matches and negotiated prints have none.
const Side = Schema.Literals(["buy", "sell", "none"])

// The market board: regular, cash (tunai), or negotiated.
const Board = Schema.Literals(["RG", "TN", "NG"])

// Where a running trade was seen: a live feed, or a backfill request's answer.
const TradeSource = Schema.Literals(["Stockbit", "Ajaib", "backfill"])

// One trade on the whole-market tape, merged across feeds. Its trade number is
// the bare daily sequence, one market-wide numbering per trading day. Value is
// price × lots × 100 shares, so it does not travel.
const RunningTrade = Schema.Struct({
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

// One stock code's or index's 1-minute candle. A stock's is built from its
// regular-board trades: volume in lots, value in rupiah, frequency in trades.
// An index's is built from its `liveprice` frames, its volume, value and
// frequency the market's over that minute.
const Candle = Schema.Struct({
  code: StockCode,
  // The minute's start.
  minute: Schema.DateTimeUtcFromMillis,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  close: Schema.Finite,
  volume: Schema.Finite,
  value: Schema.Finite,
  frequency: Schema.Int,
})
export type Candle = typeof Candle.Type

// What a viewer starts from after each Select: the 200 newest running trades,
// ascending by trade number, and the selected code's candles so far,
// ascending by minute. The selected code's order book once it has one, or
// word that it is an index.
const Snapshot = Schema.TaggedStruct("Snapshot", {
  tape: Schema.Array(RunningTrade),
  candles: Schema.Array(Candle),
  // The selected and watchlist codes' that have figures; a code missing has
  // none yet. Absent when none has.
  dayStates: Schema.optionalKey(Schema.Array(DayState)),
  orderBook: Schema.optionalKey(Schema.Union([OrderBook, IndexHasNoBook])),
  status: MarketStatus,
  // The selected code's, once it has one.
  indicative: Schema.optionalKey(IndicativePrice),
})

// The running trades that arrived in the last ~250 ms, ascending by trade
// number. A late trade sorts below ones the viewer already holds. Candles are
// every candle that changed since the last delta, of any code, each whole: the
// page keeps its selected code's. Order books likewise: every code's whose
// served book changed, each whole.
const Delta = Schema.TaggedStruct("Delta", {
  tape: Schema.Array(RunningTrade),
  candles: Schema.Array(Candle),
  // Every changed Day state of a code some viewer selected or watches, each
  // whole. Absent when none changed.
  dayStates: Schema.optionalKey(Schema.Array(DayState)),
  orderBooks: Schema.optionalKey(Schema.Array(OrderBook)),
  // Present only when it changed.
  status: Schema.optionalKey(MarketStatus),
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

export const encodeIngestUp = Schema.encodeEffect(
  Schema.fromJsonString(IngestUp)
)

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
