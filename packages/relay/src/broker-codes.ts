// Broker codes ingest (spec apinrdw/kumora#244, "@workspace/relay: broker
// codes shapes"): what the extension's post-close walks and the dashboard
// Worker agree on. The extension posts batches of each trade's broker codes
// and investor types to the day's path and asks the day's status there; the
// Worker hands both to the day's trading-day Durable Object.
import { Effect, Option, Schema } from "effect"

import { Feed, TradeNumber } from "./envelope.ts"
import { WibDate } from "./schedule.ts"

// Bump on any change to a batch's or a status's shape. Only this version is
// accepted: the Worker answers any other with 426, which the extension shows
// as `reload-extension`. Separate from IngestProtocolVersion.
export const BrokerCodesProtocolVersion = 1

const PREFIX = "/api/broker-codes"

// Where the dashboard Worker takes a day's batches (POST) and answers its
// status (GET). Nothing else lives under the prefix.
export const brokerCodesPath = (day: WibDate) =>
  Effect.sync(() => `${PREFIX}/${day}`)

const decodeDate = Schema.decodeUnknownOption(WibDate)

// The day a path names: none for a path outside the prefix, which isn't a
// broker codes path; some none for one under it that names no valid day,
// which the Worker answers with 400.
export const brokerCodesDay = (pathname: string) =>
  Effect.sync((): Option.Option<Option.Option<WibDate>> => {
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`))
      return Option.none()
    return Option.some(decodeDate(pathname.slice(PREFIX.length + 1)))
  })

// Two uppercase letters, as both sites send them.
export const BrokerCode = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}$/)
).pipe(Schema.brand("BrokerCode"))

// Domestic or foreign: the investor behind one side, not the broker.
export const InvestorType = Schema.Literals(["D", "F"])
export type InvestorType = typeof InvestorType.Type

// One running trade's broker codes and investor types, both sides.
const TradeCodes = Schema.Struct({
  buyer: BrokerCode,
  buyerType: InvestorType,
  seller: BrokerCode,
  sellerType: InvestorType,
})
export type TradeCodes = typeof TradeCodes.Type

// A batch's trade numbers: a day's sequence, 1 to Ajaib's 10 digits, so the
// dashboard keys them as safe integers.
const DayTradeNumber = TradeNumber.check(Schema.isPattern(/^[1-9]\d{0,9}$/))

// The day's highest trade number, as the walk that sends it confirmed it.
const End = Schema.Struct({ n: DayTradeNumber })

// Decision: a batch holds at most 5,000 rows, one Ajaib page at
// `page_size=5000`; a Stockbit batch holds ~1,000. The Worker reads a body
// no longer than BROKER_CODES_BATCH_LIMIT, which a full batch fits.
const BATCH_ROWS = 5_000

// In UTF-16 units of the body. A full batch at 10-digit trade numbers stays
// under it (broker-codes.test.ts).
export const BROKER_CODES_BATCH_LIMIT = 1_000_000

// One walk's trades of `day` from `feed`, posted to the day's path. A batch
// may be `end` alone, once a walk confirmed the day's highest number.
const BrokerCodesBatch = Schema.Struct({
  version: Schema.Literal(BrokerCodesProtocolVersion),
  feed: Feed,
  day: WibDate,
  rows: Schema.Array(Schema.Tuple([DayTradeNumber, TradeCodes])).check(
    Schema.isMaxLength(BATCH_ROWS)
  ),
  end: Schema.optionalKey(End),
})
export type BrokerCodesBatch = typeof BrokerCodesBatch.Type

// The day's cross-check: Ajaib supplied nothing, so Stockbit's copy has
// nothing to compare against; Stockbit's walk has reached `walkedTo`; or
// Stockbit's walk ended, having agreed on `covered` trades and disagreed on
// `differences`.
const CrossCheck = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({ state: Schema.Literal("pending"), walkedTo: TradeNumber }),
  Schema.Struct({
    state: Schema.Literal("compared"),
    covered: Schema.Int,
    differences: Schema.Int,
  }),
])
export type CrossCheck = typeof CrossCheck.Type

// A day's broker codes as its trading-day object holds them. `n` is the
// highest `end.n` either site sent, null until one did; `missing` is the
// inclusive ranges of 1..n without valid codes, or of 1..(highest held)
// while n is unknown; `sources` counts the kept trades each site supplied.
const BrokerCodesStatus = Schema.Struct({
  version: Schema.Literal(BrokerCodesProtocolVersion),
  day: WibDate,
  n: Schema.NullOr(TradeNumber),
  complete: Schema.Boolean,
  missing: Schema.Array(Schema.Tuple([TradeNumber, TradeNumber])),
  sources: Schema.Struct({ ajaib: Schema.Int, stockbit: Schema.Int }),
  crossCheck: CrossCheck,
})
export type BrokerCodesStatus = typeof BrokerCodesStatus.Type

export class BrokerCodesVersionMismatch extends Schema.TaggedError<BrokerCodesVersionMismatch>()(
  "BrokerCodesVersionMismatch",
  { received: Schema.Unknown }
) {}

const Json = Schema.fromJsonString(Schema.Unknown)
const VersionProbe = Schema.Struct({
  version: Schema.optionalKey(Schema.Unknown),
})

// Parses a batch's JSON and fails with BrokerCodesVersionMismatch unless it
// is this version, before its shape is checked: a batch from another version
// may not decode at all.
export const decodeBrokerCodesBatch = Effect.fnUntraced(function* (
  text: string
) {
  const json = yield* Schema.decodeUnknownEffect(Json)(text)
  const { version } = yield* Schema.decodeUnknownEffect(VersionProbe)(json)
  if (version !== BrokerCodesProtocolVersion)
    return yield* new BrokerCodesVersionMismatch({ received: version })
  return yield* Schema.decodeUnknownEffect(BrokerCodesBatch)(json)
})

export const encodeBrokerCodesBatch = Schema.encodeEffect(
  Schema.fromJsonString(BrokerCodesBatch)
)

export const decodeBrokerCodesStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BrokerCodesStatus)
)

export const encodeBrokerCodesStatus = Schema.encodeEffect(
  Schema.fromJsonString(BrokerCodesStatus)
)

// Ajaib's `v1/stock/detail/running_trades/` row: `buyer` and `seller` bare
// codes, `buyer_type` and `seller_type` `D` or `F` (every row of the
// 2026-11-12 probe). Its trade number is `ajaibSequence` of `trade_num`.
const AjaibRow = Schema.Struct({
  buyer: BrokerCode,
  buyer_type: InvestorType,
  seller: BrokerCode,
  seller_type: InvestorType,
})
const decodeAjaibRow = Schema.decodeUnknownOption(AjaibRow)

// An Ajaib row's codes; none when either side's code or type isn't valid,
// so the trade counts as missing and is fetched again.
export const ajaibRowCodes = (row: unknown) =>
  Effect.sync(() =>
    Option.map(decodeAjaibRow(row), (valid): TradeCodes => ({
      buyer: valid.buyer,
      buyerType: valid.buyer_type,
      seller: valid.seller,
      sellerType: valid.seller_type,
    }))
  )

// Stockbit's `order-trade/running-trade` row: `buyer` and `seller` each a
// code tagged with its investor type, `XX [D]` or `XX [F]`. Its own
// `buyer_type`/`seller_type` name the broker, not the investor, so they are
// not read.
const StockbitRow = Schema.Struct({
  is_broker_exists: Schema.optionalKey(Schema.Boolean),
  buyer: Schema.String,
  seller: Schema.String,
})
const decodeStockbitRow = Schema.decodeUnknownOption(StockbitRow)

const TAGGED = /^(?<code>[A-Z]{2}) \[(?<type>[DF])\]$/
const decodeCode = Schema.decodeUnknownOption(BrokerCode)
const decodeType = Schema.decodeUnknownOption(InvestorType)

// One side of a Stockbit row, compared after trim; none when it isn't a
// tagged code.
const taggedSide = (text: string) =>
  Effect.sync(() => {
    const groups = TAGGED.exec(text.trim())?.groups
    return Option.zipWith(
      decodeCode(groups?.code),
      decodeType(groups?.type),
      (code, type) => ({ code, type })
    )
  })

// A Stockbit row's codes; none when the row says it has no brokers, or
// either side isn't a tagged code.
export const stockbitRowCodes = Effect.fnUntraced(function* (row: unknown) {
  const valid = decodeStockbitRow(row)
  if (Option.isNone(valid) || valid.value.is_broker_exists === false)
    return Option.none<TradeCodes>()
  return Option.zipWith(
    yield* taggedSide(valid.value.buyer),
    yield* taggedSide(valid.value.seller),
    (buyer, seller): TradeCodes => ({
      buyer: buyer.code,
      buyerType: buyer.type,
      seller: seller.code,
      sellerType: seller.type,
    })
  )
})
