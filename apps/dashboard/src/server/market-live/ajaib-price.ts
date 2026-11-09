// Ajaib's `PRICE` frames, from the on-demand sockets the relay holds for the
// codes viewers have open (spec apinrdw/kumora#138, "Decoding (Worker-side)").
// Day state falls back to them while Stockbit's feed is lost.
import { StockCode, wibDateAt, type WibDate } from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect, Option, Schema } from "effect"

// Only a `PRICE` frame carries `pctChange` and `tradableVolume`.
const AjaibPriceFrame = Schema.Struct({
  ticker: StockCode,
  price: Schema.Finite,
  change: Schema.Finite,
  // A fraction: -0.014634 is −1.46%.
  pctChange: Schema.Finite,
  // Shares.
  tradableVolume: Schema.Finite,
  hi: Schema.Finite,
  lo: Schema.Finite,
  open: Schema.Finite,
  // The previous close.
  close: Schema.Finite,
  updateTime: Schema.DateTimeUtcFromMillis,
})

const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(AjaibPriceFrame)
)

export interface AjaibPrice {
  readonly code: StockCode
  readonly last: number
  readonly change: number
  // In percent.
  readonly changePercent: number
  readonly previousClose: number
  readonly open: number
  readonly high: number
  readonly low: number
  // Shares.
  readonly volume: number
  readonly time: DateTime.Utc
}

// The `PRICE` frames in one connection's frames that belong to `date`; any
// other frame is skipped.
export const ajaibPrices = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<string>
) {
  const prices: Array<AjaibPrice> = []
  for (const frame of frames) {
    const decoded = decodeFrame(frame)
    if (Option.isNone(decoded)) continue
    const price = decoded.value
    if ((yield* wibDateAt(price.updateTime)) !== date) continue
    prices.push({
      code: price.ticker,
      last: price.price,
      change: price.change,
      changePercent: price.pctChange * 100,
      previousClose: price.close,
      open: price.open,
      high: price.hi,
      low: price.lo,
      volume: price.tradableVolume,
      time: price.updateTime,
    })
  }
  return prices
})
