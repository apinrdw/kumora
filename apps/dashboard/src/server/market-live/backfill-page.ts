// The brokers' REST running-trade pages into running trades (spec
// apinrdw/kumora#138, "Backfill"). The relay fetches a page to answer a
// Backfill request and sends its raw body up; only the rows numbered inside
// the page's range are kept, each marked backfill. A row that doesn't decode
// is skipped.
import {
  AjaibTradeNum,
  TradeNumber,
  ajaibRowFields,
  ajaibTradeNumber,
  stockbitRowFields,
  tradeNumberValue,
  type BackfillPage,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

// Stockbit's `GET /order-trade/running-trade`: its rows on the page's
// `data.date`. Captured 2026-11-06.
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
})

// Ajaib's `GET v1/stock/detail/running_trades/`: `trade_num` in Ajaib's
// form. Captured 2026-11-06.
const AjaibPage = Schema.fromJsonString(
  Schema.Struct({ results: Schema.Array(Schema.Unknown) })
)
const AjaibRow = Schema.Struct({ trade_num: AjaibTradeNum })

const decodeStockbitPage = Schema.decodeUnknownOption(StockbitPage)
const decodeStockbitRow = Schema.decodeUnknownOption(StockbitRow)
const decodeAjaibPage = Schema.decodeUnknownOption(AjaibPage)
const decodeAjaibRow = Schema.decodeUnknownOption(AjaibRow)

const stockbitRows = Effect.fnUntraced(function* (date: WibDate, body: string) {
  const page = decodeStockbitPage(body)
  if (Option.isNone(page)) return []
  if ((page.value.data.date ?? date) !== date) return []
  const trades: Array<RunningTrade> = []
  for (const raw of page.value.data.running_trade) {
    const row = decodeStockbitRow(raw)
    const fields = yield* stockbitRowFields(date, raw)
    if (Option.isNone(row) || Option.isNone(fields)) continue
    trades.push({
      tradeNumber: TradeNumber.make(BigInt(row.value.trade_number).toString()),
      ...fields.value,
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
    const fields = yield* ajaibRowFields(raw)
    if (Option.isNone(row) || Option.isNone(fields)) continue
    const tradeNumber = yield* ajaibTradeNumber(date, row.value.trade_num)
    if (Option.isNone(tradeNumber)) continue
    trades.push({
      tradeNumber: tradeNumber.value,
      ...fields.value,
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
