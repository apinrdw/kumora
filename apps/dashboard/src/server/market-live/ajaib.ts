// Ajaib's raw frames into running trades (spec apinrdw/kumora#138, "Decoding
// (Worker-side)"). A frame that isn't a trade (a subscribe ack, a PRICE or
// order book frame) is skipped: other tickets decode those.
import {
  StockCode,
  TradeNumber,
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
  // `YYYYMMDD` and the 10-digit daily sequence.
  tradeNum: Schema.String.check(Schema.isPattern(/^\d{18}$/)),
  market_type: Schema.optionalKey(Schema.String),
})

const decodeTrade = Schema.decodeUnknownOption(
  Schema.fromJsonString(AjaibTrade)
)

// Decision: a trade frame without `market_type` is on the regular board. The
// 2026-11-09 probe saw no `market_type` on any of 44,360 TRADE frames, all
// regular-board stocks; an unknown value is read the same way until a capture
// shows the cash and negotiated boards' frames.
const boardOf = (marketType: string | undefined): RunningTrade["board"] =>
  marketType === "TN" || marketType === "NG" ? marketType : "RG"

// The running trades in one connection's frames that belong to `date`. Trade
// numbers lose their date prefix: the tape's number is the bare daily
// sequence, the one Stockbit sends.
export const ajaibTrades = (date: WibDate, frames: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const prefix = date.replaceAll("-", "")
    const trades: Array<RunningTrade> = []
    for (const frame of frames) {
      const decoded = decodeTrade(frame)
      if (Option.isNone(decoded)) continue
      const trade = decoded.value
      if (!trade.tradeNum.startsWith(prefix)) continue
      trades.push({
        tradeNumber: TradeNumber.make(
          BigInt(trade.tradeNum.slice(8)).toString()
        ),
        time: trade.tradedAt,
        code: trade.ticker,
        price: trade.price,
        lots: trade.lot,
        // The auction match and negotiated board rule applies on the merged
        // tape (trading-day.ts).
        side: trade.type === "BUY" ? "buy" : "sell",
        board: boardOf(trade.market_type),
        feeds: ["Ajaib"],
      })
    }
    return trades
  })
