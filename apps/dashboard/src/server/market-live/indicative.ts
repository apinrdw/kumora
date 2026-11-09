// Indicative prices from both feeds (spec apinrdw/kumora#138, "Indicative
// price"): Stockbit's `iepiev` for every code, Ajaib's `INDICATIVE` for the
// codes viewers have open. Both carry the volume in shares.
import { StockCode, type IndicativePrice } from "@workspace/relay"
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

export const stockbitIndicative = (frames: ReadonlyArray<Uint8Array>) =>
  Effect.sync(() =>
    frames
      .flatMap((frame) => messagesAt(frame, IEPIEV))
      .flatMap((bytes) => stockbitOne(bytes) ?? [])
  )

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

export const ajaibIndicative = (frames: ReadonlyArray<string>) =>
  Effect.sync(() =>
    frames.flatMap((frame) => {
      const decoded = decodeAjaib(frame)
      if (Option.isNone(decoded)) return []
      const { ticker, openPrice, openQty, updateTime } = decoded.value
      return [
        { code: ticker, price: openPrice, volume: openQty, at: updateTime },
      ]
    })
  )
