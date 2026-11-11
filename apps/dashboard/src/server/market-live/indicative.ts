// Indicative prices from both feeds (spec apinrdw/kumora#138, "Indicative
// price"): Stockbit's `iepiev` for every code, Ajaib's `INDICATIVE` for the
// codes viewers have open. Both carry the volume in shares. As with the
// other price decoders, a frame from another trading day, which a broker
// may send from its cache, is skipped.
import {
  StockCode,
  wibDateAt,
  type IndicativePrice,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { bytesOf, fieldReader, messagesAt, numberOf } from "./stockbit.ts"

// `WebsocketWrapMessageChannel` case 11, `IepIev`: 1 stock code, 2 price,
// 3 volume (shares), 5 the exchange's time as ISO text with the WIB offset.
const IEPIEV = 11
const IepIev = { code: 1, price: 2, volume: 3, time: 5 } as const

const isStockCode = Schema.is(StockCode)
const decodeInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)

const stockbitOne = (bytes: Uint8Array): IndicativePrice | undefined => {
  const read = fieldReader(bytes)
  if (read === undefined) return undefined
  const code = new TextDecoder().decode(bytesOf(read(IepIev.code)))
  const price = numberOf(read(IepIev.price))
  const volume = numberOf(read(IepIev.volume)) ?? 0
  const at = decodeInstant(new TextDecoder().decode(bytesOf(read(IepIev.time))))
  if (!isStockCode(code) || price === undefined || Option.isNone(at))
    return undefined
  return { code, price, volume, at: at.value }
}

export const stockbitIndicative = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<Uint8Array>
) {
  const prices: Array<IndicativePrice> = []
  for (const bytes of frames.flatMap((frame) => messagesAt(frame, IEPIEV))) {
    const price = stockbitOne(bytes)
    if (price !== undefined && (yield* wibDateAt(price.at)) === date)
      prices.push(price)
  }
  return prices
})

// Ajaib's `INDICATIVE` frame; only it carries `openPrice`.
const AjaibIndicative = Schema.Struct({
  ticker: StockCode,
  openPrice: Schema.Finite,
  openQty: Schema.Finite,
  updateTime: Schema.DateTimeUtcFromMillis,
})
const decodeAjaib = Schema.decodeUnknownOption(
  Schema.fromJsonString(AjaibIndicative)
)

export const ajaibIndicative = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<string>
) {
  const prices: Array<IndicativePrice> = []
  for (const frame of frames) {
    const decoded = decodeAjaib(frame)
    if (Option.isNone(decoded)) continue
    const { ticker, openPrice, openQty, updateTime } = decoded.value
    if ((yield* wibDateAt(updateTime)) !== date) continue
    prices.push({
      code: ticker,
      price: openPrice,
      volume: openQty,
      at: updateTime,
    })
  }
  return prices
})
