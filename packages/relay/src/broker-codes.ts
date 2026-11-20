// Broker codes ingest (spec apinrdw/kumora#244, "@workspace/relay: broker
// codes shapes"): what the extension's post-close walks and the dashboard
// Worker agree on. The extension posts batches of each trade's broker codes,
// investor types and trade fields to the day's path and asks the day's
// status there; the Worker hands both to the day's trading-day Durable
// Object.
import { DateTime, Effect, Option, Schema } from "effect"

import { StockCode } from "./codes.ts"
import {
  Board,
  Feed,
  Side,
  TradeNumber,
  boardOf,
  groupedNumber,
} from "./envelope.ts"
import { WibDate } from "./schedule.ts"

// Bump on any change to a batch's or a status's shape. Only this version is
// accepted: the Worker answers any other with 426, which the extension shows
// as `reload-extension`. Separate from IngestProtocolVersion.
// Decision: 2 since the status lists at most MISSING_RANGES ranges; 3 since
// rows carry trade fields (apinrdw/kumora#425); 4 since they carry time and
// side, which a walk day takes as its tape, and 0.0.29 sent 3 without them
// (#437); 5 since a row may carry order numbers and the status counts them
// (#627). An older extension gets 426 and shows `reload-extension`.
export const BrokerCodesProtocolVersion = 5

const PREFIX = "/api/broker-codes"

const decodeDate = Schema.decodeUnknownOption(WibDate)
const decodeTradeNumber = Schema.decodeUnknownOption(TradeNumber)

// Where the dashboard Worker takes a day's batches (POST) and answers its
// status (GET). Nothing else lives under the prefix.
export const brokerCodesPath = (day: WibDate) =>
  Effect.sync(() => `${PREFIX}/${day}`)

// The status GET's query naming the trade number its `missing` starts
// after; absent is 0, so the list starts at trade 1.
const AFTER = "after"

// Where the extension asks a day's status, listing ranges after `after`.
export const brokerCodesStatusPath = (day: WibDate, after: TradeNumber) =>
  Effect.map(brokerCodesPath(day), (path) => `${path}?${AFTER}=${after}`)

// What a status GET's query (its URLSearchParams) names to list after: none
// when `after` is there but isn't a trade number.
export const brokerCodesAfter = (search: {
  readonly get: (name: string) => string | null
}) =>
  Effect.sync(() => {
    const after = search.get(AFTER)
    if (after === null) return Option.some(0)
    return Option.filter(
      Option.map(decodeTradeNumber(after), Number),
      Number.isSafeInteger
    )
  })

// What precedes the ingest token in a batch POST's or a status GET's
// `authorization` header.
export const BROKER_CODES_AUTH_SCHEME = "Bearer "

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
export type BrokerCode = typeof BrokerCode.Type

// Domestic or foreign: the investor behind one side, not the broker.
export const InvestorType = Schema.Literals(["D", "F"])
export type InvestorType = typeof InvestorType.Type

// One running trade's broker codes and investor types, both sides.
export const TradeCodes = Schema.Struct({
  buyer: BrokerCode,
  buyerType: InvestorType,
  seller: BrokerCode,
  sellerType: InvestorType,
})
export type TradeCodes = typeof TradeCodes.Type

// One running trade's own fields, as a broker's REST row reads them: what
// the day's tape holds for it, but its feeds.
// Decision: lots may be 0. Ajaib's tape cuts a negotiated-board trade's
// fractional lots to 0 (CTRA, trade 1559660 on 2026-11-16, NG), and a
// walk that dropped the row would drop its codes too. Broker totals and
// candles count the regular board only, so the 0 never reaches a figure.
const TradeFields = Schema.Struct({
  time: Schema.DateTimeUtcFromMillis,
  code: StockCode,
  price: Schema.Int,
  lots: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  board: Board,
  side: Side,
})
export type TradeFields = typeof TradeFields.Type
const decodeFields = Schema.decodeUnknownOption(TradeFields)

// A batch's trade numbers: a day's sequence, 1 to Ajaib's 10 digits, so the
// dashboard keys them as safe integers.
export const DayTradeNumber = TradeNumber.check(
  Schema.isPattern(/^[1-9]\d{0,9}$/)
)

// One order's number on its day, as Stockbit sends it and as the last 10
// digits of Ajaib's `order_id`: one count over every stock code and both
// sides, from 1 each day.
// Decision: at most 2^32 - 1, so the trading-day object keeps each as a
// uint32 (#624). A day's count reached about 3.1 M by HOPE's last trade on
// 2026-11-20, three orders of magnitude below it.
const OrderNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 0xff_ff_ff_ff })
)

// A trade's buy order's and sell order's numbers.
const OrderNumbers = Schema.Tuple([OrderNumber, OrderNumber])
export type OrderNumbers = typeof OrderNumbers.Type

// The day's highest trade number, as the walk that sends it confirmed it.
const End = Schema.Struct({ n: DayTradeNumber })

// Decision: a batch holds at most 5,000 rows, one Ajaib page at
// `page_size=5000`; a Stockbit batch holds ~1,000. The Worker reads a body
// no longer than BROKER_CODES_BATCH_LIMIT, which a full batch fits.
const BATCH_ROWS = 5_000

// In UTF-16 units of the body. A full batch at 10-digit trade numbers,
// 16-character stock codes and the latest time a Date holds stays under it
// (broker-codes.test.ts).
export const BROKER_CODES_BATCH_LIMIT = 1_200_000

// One walk's trades of `day` from `feed`, posted to the day's path: each
// row's trade number, codes and fields, and its order numbers when the walk
// read them. A walk sends no row it read without valid codes, and leaves out
// the fields of a row without valid fields, so either way the trade counts
// as missing. A row with order numbers but no fields holds null in place of
// its fields. A batch may be `end` alone, once a walk confirmed the day's
// highest number.
const BrokerCodesBatch = Schema.Struct({
  version: Schema.Literal(BrokerCodesProtocolVersion),
  feed: Feed,
  day: WibDate,
  rows: Schema.Array(
    Schema.Tuple([
      DayTradeNumber,
      TradeCodes,
      Schema.optionalKey(Schema.NullOr(TradeFields)),
      Schema.optionalKey(OrderNumbers),
    ])
  ).check(Schema.isMaxLength(BATCH_ROWS)),
  end: Schema.optionalKey(End),
})
export type BrokerCodesBatch = typeof BrokerCodesBatch.Type
export type BatchRow = BrokerCodesBatch["rows"][number]

// A trade's batch row: its fields and its order numbers only when the walk
// read them valid.
export const batchRow = (
  number: TradeNumber,
  codes: TradeCodes,
  fields: Option.Option<TradeFields>,
  orders: Option.Option<OrderNumbers> = Option.none()
) =>
  Effect.succeed<BatchRow>(
    Option.isSome(orders)
      ? [number, codes, Option.getOrNull(fields), orders.value]
      : Option.isSome(fields)
        ? [number, codes, fields.value]
        : [number, codes]
  )

// The day's trades holding order numbers from each site, and the Stockbit
// rows whose order numbers differed from Ajaib's held ones.
const OrderNumberCounts = Schema.Struct({
  ajaib: Schema.Int,
  stockbit: Schema.Int,
  differences: Schema.Int,
})

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

// Decision: a status lists at most 1,000 missing ranges, the first after
// the GET's `after`, and counts every missing trade in `missingCount`. A
// 1.5M-trade day missing every other trade has 750,000 ranges, which as one
// list exhausted a Worker's 128 MiB. A walk pages on with `after`.
export const MISSING_RANGES = 1_000

// A day's broker codes as its trading-day object holds them. `n` is the
// highest `end.n` either site sent, null until one did. A trade is held
// once the day has its codes and its fields, from the tape or a walk's row.
// The day's missing trades are the inclusive ranges of 1..n not held, or of
// 1..(highest held) while n is unknown: `missingCount` counts them all, and
// `missing` lists the first MISSING_RANGES ranges of them past the GET's
// `after`, clipped to start after it. `complete` is n known and none
// missing. `sources` counts the kept codes each site supplied, and
// `orderNumbers` the trades holding order numbers from each site and the
// Stockbit rows that disagreed with Ajaib's; order numbers never decide
// `complete` or `missing`.
const BrokerCodesStatus = Schema.Struct({
  version: Schema.Literal(BrokerCodesProtocolVersion),
  day: WibDate,
  n: Schema.NullOr(TradeNumber),
  complete: Schema.Boolean,
  missing: Schema.Array(Schema.Tuple([TradeNumber, TradeNumber])).check(
    Schema.isMaxLength(MISSING_RANGES)
  ),
  missingCount: Schema.Int,
  sources: Schema.Struct({ ajaib: Schema.Int, stockbit: Schema.Int }),
  crossCheck: CrossCheck,
  orderNumbers: OrderNumberCounts,
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

// Stockbit's row's `buy_order_number` and `sell_order_number`, digit strings
// filled once the day has closed. Its `group_order_number` names the passive
// order in about a third of trades (#617), so it is not read.
const StockbitOrdersRow = Schema.Struct({
  buy_order_number: Schema.String.check(Schema.isPattern(/^\d+$/)),
  sell_order_number: Schema.String.check(Schema.isPattern(/^\d+$/)),
})
const decodeStockbitOrdersRow = Schema.decodeUnknownOption(StockbitOrdersRow)
const decodeOrderNumbers = Schema.decodeUnknownOption(OrderNumbers)

// A Stockbit row's order numbers; none unless both are positive integers,
// so the trade simply lacks them.
export const stockbitRowOrderNumbers = (row: unknown) =>
  Effect.sync(() =>
    Option.flatMap(decodeStockbitOrdersRow(row), (valid) =>
      decodeOrderNumbers([
        Number(valid.buy_order_number),
        Number(valid.sell_order_number),
      ])
    )
  )

// Ajaib's and Stockbit's REST running-trade rows (`v1/stock/detail/
// running_trades/`, `order-trade/running-trade`), read alike by the walks and
// Market Live's backfill (spec apinrdw/kumora#437, "@workspace/relay"). Ajaib
// sends `stock_code`, `price` and `lot` as numbers, `side`, and `timestamp`
// in epoch ms. Stockbit sends `code`, `price` and `lot` comma-grouped
// ("2,300"), `time` as WIB `HH:MM:SS` on the day, and `action`. Both boards
// read as the live tape reads them (`boardOf`). Captured 2026-11-06.
const AjaibFieldsRow = Schema.Struct({
  stock_code: Schema.Unknown,
  price: Schema.Unknown,
  lot: Schema.Unknown,
  side: Schema.String,
  timestamp: Schema.Unknown,
  market_type: Schema.optionalKey(Schema.String),
})
const StockbitFieldsRow = Schema.Struct({
  time: Schema.String.check(Schema.isPattern(/^\d\d:\d\d:\d\d$/)),
  code: Schema.Unknown,
  price: Schema.String,
  lot: Schema.String,
  action: Schema.optionalKey(Schema.String),
  market_board: Schema.optionalKey(Schema.String),
})
const decodeAjaibFieldsRow = Schema.decodeUnknownOption(AjaibFieldsRow)
const decodeStockbitFieldsRow = Schema.decodeUnknownOption(StockbitFieldsRow)

// "buy" or "sell" in any case; anything else is neither side.
const sideOf = (side: string | undefined) =>
  Effect.sync((): typeof Side.Type => {
    const lower = side?.toLowerCase()
    return lower === "buy" || lower === "sell" ? lower : "none"
  })

// An Ajaib row's fields; none when any isn't valid, so the trade counts as
// missing and is fetched again.
export const ajaibRowFields = Effect.fnUntraced(function* (row: unknown) {
  const valid = decodeAjaibFieldsRow(row)
  if (Option.isNone(valid)) return Option.none<TradeFields>()
  return decodeFields({
    time: valid.value.timestamp,
    code: valid.value.stock_code,
    price: valid.value.price,
    lots: valid.value.lot,
    board: yield* boardOf(valid.value.market_type),
    side: yield* sideOf(valid.value.side),
  })
})

// A Stockbit row's fields on `day`; none when any isn't valid.
export const stockbitRowFields = Effect.fnUntraced(function* (
  day: WibDate,
  row: unknown
) {
  const valid = decodeStockbitFieldsRow(row)
  if (Option.isNone(valid)) return Option.none<TradeFields>()
  const time = DateTime.make(`${day}T${valid.value.time}+07:00`)
  if (Option.isNone(time)) return Option.none<TradeFields>()
  return decodeFields({
    time: DateTime.toEpochMillis(time.value),
    code: valid.value.code,
    price: yield* groupedNumber(valid.value.price),
    lots: yield* groupedNumber(valid.value.lot),
    board: yield* boardOf(valid.value.market_board),
    side: yield* sideOf(valid.value.action),
  })
})
