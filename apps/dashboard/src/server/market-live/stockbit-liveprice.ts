// Stockbit's `liveprice` frames (wrapper case 9) into the day's running
// figures per code (spec apinrdw/kumora#138, "Decoding (Worker-side)"): the
// index candles and every code's Day state read them.
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
  high: 4,
  low: 5,
  open: 6,
  frequency: 7,
  date: 11,
  previous: 13,
  value: 14,
  change: 15,
  isIndex: 18,
  board: 23,
} as const

// `Change`'s fields: the change from the previous close, and it in percent.
const ChangeField = { value: 1, percent: 2 } as const

// `BoardType` 1, the regular board. An index's frame carries none.
const REGULAR_BOARD = 1

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
  // The day's, so far; absent on a frame that carries only the totals.
  readonly high: number | undefined
  readonly low: number | undefined
  readonly open: number | undefined
  readonly previousClose: number | undefined
  readonly change: number | undefined
  readonly changePercent: number | undefined
  // False for a cash or negotiated board's frame of the code.
  readonly regularBoard: boolean
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
  const changeBytes = bytesOf(read(Field.change))
  const change =
    changeBytes === undefined ? undefined : fieldReader(changeBytes)
  const board = numberOf(read(Field.board))
  return {
    code,
    time,
    last: numberOf(read(Field.last)),
    volume: numberOf(read(Field.volume)) ?? 0,
    value: numberOf(read(Field.value)) ?? 0,
    frequency: numberOf(read(Field.frequency)) ?? 0,
    isIndex: numberOf(read(Field.isIndex)) === 1,
    high: numberOf(read(Field.high)),
    low: numberOf(read(Field.low)),
    open: numberOf(read(Field.open)),
    previousClose: numberOf(read(Field.previous)),
    change: numberOf(change?.(ChangeField.value)),
    changePercent: numberOf(change?.(ChangeField.percent)),
    regularBoard: board === undefined || board === REGULAR_BOARD,
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
