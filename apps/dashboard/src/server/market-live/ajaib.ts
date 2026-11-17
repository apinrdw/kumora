// Ajaib's raw frames into running trades (spec apinrdw/kumora#138, "Decoding
// (Worker-side)"). A frame that isn't a trade (a subscribe ack, a PRICE or
// order book frame) is skipped: other tickets decode those.
import {
  AjaibTradeNum,
  StockCode,
  ajaibTradeNumber,
  boardOf,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

const AjaibTrade = Schema.Struct({
  ticker: StockCode,
  type: Schema.Literals(["BUY", "SELL"]),
  price: Schema.Int,
  lot: Schema.Int,
  // Whole seconds, with the WIB offset.
  tradedAt: Schema.DateTimeUtcFromString,
  tradeNum: AjaibTradeNum,
  market_type: Schema.optionalKey(Schema.String),
})

const decodeTrade = Schema.decodeUnknownOption(
  Schema.fromJsonString(AjaibTrade)
)

// The running trades in one connection's frames that belong to `date`, under
// their tape trade numbers.
export const ajaibTrades = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<string>
) {
  const trades: Array<RunningTrade> = []
  for (const frame of frames) {
    const decoded = decodeTrade(frame)
    if (Option.isNone(decoded)) continue
    const trade = decoded.value
    const tradeNumber = yield* ajaibTradeNumber(date, trade.tradeNum)
    if (Option.isNone(tradeNumber)) continue
    trades.push({
      tradeNumber: tradeNumber.value,
      time: trade.tradedAt,
      code: trade.ticker,
      price: trade.price,
      lots: trade.lot,
      // The auction match and negotiated board rule applies on the merged
      // tape (trading-day.ts).
      side: trade.type === "BUY" ? "buy" : "sell",
      board: yield* boardOf(trade.market_type),
      feeds: ["Ajaib"],
    })
  }
  return trades
})
