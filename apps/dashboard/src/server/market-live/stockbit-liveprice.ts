// Stockbit's `liveprice` frames (wrapper case 9) into the day's running
// figures per code (spec apinrdw/kumora#138, "Decoding (Worker-side)"). Only
// the fields Market Live reads so far are decoded; Day state adds the rest.
import { StockCode, wibDateAt, type WibDate } from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import { bytesOf, fieldReader, messagesAt, numberOf } from "./stockbit.ts"

const LIVEPRICE = 9

// `LivePrice`'s fields. Volume, value and frequency are the day's totals so
// far; `date` is the frame's ISO time with the WIB offset.
const Field = {
  stockCode: 1,
  last: 2,
  volume: 3,
  frequency: 7,
  date: 11,
  value: 14,
  isIndex: 18,
} as const

// One code's figures as one `liveprice` frame carried them.
export interface LivePrice {
  readonly code: StockCode
  readonly time: DateTime.Utc
  // Some frames carry only the totals: the last price is unchanged.
  readonly last: number | undefined
  // Shares.
  readonly volume: number
  readonly value: number
  readonly frequency: number
  readonly isIndex: boolean
}

const isStockCode = Schema.is(StockCode)

const livePriceOf = (bytes: Uint8Array): LivePrice | undefined => {
  const read = fieldReader(bytes)
  if (read === undefined) return undefined
  const text = (number: number) => {
    const run = bytesOf(read(number))
    return run === undefined ? undefined : new TextDecoder().decode(run)
  }
  const code = text(Field.stockCode)
  const time = Option.getOrUndefined(
    DateTime.make(text(Field.date) ?? "").pipe(Option.map(DateTime.toUtc))
  )
  if (code === undefined || !isStockCode(code) || time === undefined)
    return undefined
  return {
    code,
    time,
    last: numberOf(read(Field.last)),
    volume: numberOf(read(Field.volume)) ?? 0,
    value: numberOf(read(Field.value)) ?? 0,
    frequency: numberOf(read(Field.frequency)) ?? 0,
    isIndex: numberOf(read(Field.isIndex)) === 1,
  }
}

// The `liveprice` frames in one connection's frames that belong to `date`.
export const stockbitLivePrices = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<Uint8Array>
) {
  const prices: Array<LivePrice> = []
  for (const bytes of frames.flatMap((frame) => messagesAt(frame, LIVEPRICE))) {
    const price = livePriceOf(bytes)
    if (price !== undefined && (yield* wibDateAt(price.time)) === date)
      prices.push(price)
  }
  return prices
})
