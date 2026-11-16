// The brokers' REST running-trade pages into running trades (spec
// apinrdw/kumora#138, "Backfill"). The relay fetches a page to answer a
// Backfill request and sends its raw body up; only the rows numbered inside
// the page's range are kept, each marked backfill. A row that doesn't decode
// is skipped.
import {
  AjaibTradeNum,
  StockCode,
  TradeNumber,
  ajaibTradeNumber,
  boardOf,
  groupedNumber,
  tradeNumberValue,
  type BackfillPage,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

// Stockbit's `GET /order-trade/running-trade`: numbers as comma-grouped
// strings ("2,300"), the time as WIB `HH:MM:SS` on the page's `data.date`,
// and `action` "buy" or "sell". Captured 2026-11-06.
const StockbitPage = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      date: Schema.optionalKey(Schema.String),
      running_trade: Schema.Array(Schema.Unknown),
    }),
  })
)
const StockbitRow = Schema.Struct({
  trade_number: Schema.String.check(Schema.isPattern(/^\d+$/)),
  time: Schema.String.check(Schema.isPattern(/^\d\d:\d\d:\d\d$/)),
  code: StockCode,
  price: Schema.String,
  lot: Schema.String,
  action: Schema.optionalKey(Schema.String),
  market_board: Schema.optionalKey(Schema.String),
})

// Ajaib's `GET v1/stock/detail/running_trades/`: `trade_num` in Ajaib's
// form, `timestamp` epoch ms. Captured 2026-11-06.
const AjaibPage = Schema.fromJsonString(
  Schema.Struct({ results: Schema.Array(Schema.Unknown) })
)
const AjaibRow = Schema.Struct({
  trade_num: AjaibTradeNum,
  stock_code: StockCode,
  price: Schema.Int,
  lot: Schema.Finite,
  side: Schema.String,
  timestamp: Schema.Finite,
  market_type: Schema.optionalKey(Schema.String),
})

const decodeStockbitPage = Schema.decodeUnknownOption(StockbitPage)
const decodeStockbitRow = Schema.decodeUnknownOption(StockbitRow)
const decodeAjaibPage = Schema.decodeUnknownOption(AjaibPage)
const decodeAjaibRow = Schema.decodeUnknownOption(AjaibRow)

const sideOf = (side: string | undefined) =>
  Effect.sync((): RunningTrade["side"] => {
    const lower = side?.toLowerCase()
    return lower === "buy" || lower === "sell" ? lower : "none"
  })

const stockbitRows = Effect.fnUntraced(function* (date: WibDate, body: string) {
  const page = decodeStockbitPage(body)
  if (Option.isNone(page)) return []
  if ((page.value.data.date ?? date) !== date) return []
  const trades: Array<RunningTrade> = []
  for (const raw of page.value.data.running_trade) {
    const row = decodeStockbitRow(raw)
    if (Option.isNone(row)) continue
    const { value } = row
    const time = DateTime.make(`${date}T${value.time}+07:00`)
    const price = yield* groupedNumber(value.price)
    const lots = yield* groupedNumber(value.lot)
    if (Option.isNone(time) || !Number.isInteger(price) || !(lots > 0)) continue
    trades.push({
      tradeNumber: TradeNumber.make(BigInt(value.trade_number).toString()),
      time: DateTime.toUtc(time.value),
      code: value.code,
      price,
      lots,
      side: yield* sideOf(value.action),
      board: yield* boardOf(value.market_board),
      feeds: ["backfill"],
    })
  }
  return trades
})

const ajaibRows = Effect.fnUntraced(function* (date: WibDate, body: string) {
  const page = decodeAjaibPage(body)
  if (Option.isNone(page)) return []
  const trades: Array<RunningTrade> = []
  for (const raw of page.value.results) {
    const row = decodeAjaibRow(raw)
    if (Option.isNone(row)) continue
    const { value } = row
    const tradeNumber = yield* ajaibTradeNumber(date, value.trade_num)
    if (Option.isNone(tradeNumber)) continue
    trades.push({
      tradeNumber: tradeNumber.value,
      time: DateTime.makeUnsafe(value.timestamp),
      code: value.stock_code,
      price: value.price,
      lots: value.lot,
      side: yield* sideOf(value.side),
      board: yield* boardOf(value.market_type),
      feeds: ["backfill"],
    })
  }
  return trades
})

// The page's trades of `date` numbered from its `from` to its `to`.
export const backfillTrades = Effect.fnUntraced(function* (
  date: WibDate,
  page: BackfillPage
) {
  const from = yield* tradeNumberValue(page.from)
  const to = yield* tradeNumberValue(page.to)
  const rows =
    page.feed === "Stockbit"
      ? yield* stockbitRows(date, page.body)
      : yield* ajaibRows(date, page.body)
  return yield* Effect.filter(rows, (trade) =>
    Effect.map(
      tradeNumberValue(trade.tradeNumber),
      (number) => number >= from && number <= to
    )
  )
})
