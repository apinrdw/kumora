// Stockbit's `liveprice` frames (wrapper case 9) into the day's running
// figures per code (spec apinrdw/kumora#138, "Decoding (Worker-side)"): the
// index candles and every code's Day state read them.
import { StockCode, wibDateAt, type WibDate } from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import {
  bytesOf,
  fieldReader,
  messagesIn,
  numberOf,
  textOf,
} from "./stockbit.ts"

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
  // The previous close, when the frame carries it.
  readonly previous: number | undefined
  readonly isIndex: boolean
  // The day's, so far; absent on a frame that carries only the totals.
  readonly high: number | undefined
  readonly low: number | undefined
  readonly open: number | undefined
  readonly change: number | undefined
  readonly changePercent: number | undefined
  // False for a cash or negotiated board's frame of the code.
  readonly regularBoard: boolean
}

const isStockCode = Schema.is(StockCode)

const livePriceOf = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const read = yield* fieldReader(bytes)
  if (read === undefined) return undefined
  const code = yield* textOf(read.get(Field.stockCode))
  const time = Option.getOrUndefined(
    DateTime.make((yield* textOf(read.get(Field.date))) ?? "").pipe(
      Option.map(DateTime.toUtc)
    )
  )
  if (code === undefined || !isStockCode(code) || time === undefined)
    return undefined
  const changeBytes = yield* bytesOf(read.get(Field.change))
  const change =
    changeBytes === undefined ? undefined : yield* fieldReader(changeBytes)
  const board = yield* numberOf(read.get(Field.board))
  const price: LivePrice = {
    code,
    time,
    last: yield* numberOf(read.get(Field.last)),
    volume: (yield* numberOf(read.get(Field.volume))) ?? 0,
    value: (yield* numberOf(read.get(Field.value))) ?? 0,
    frequency: (yield* numberOf(read.get(Field.frequency))) ?? 0,
    previous: yield* numberOf(read.get(Field.previous)),
    isIndex: (yield* numberOf(read.get(Field.isIndex))) === 1,
    high: yield* numberOf(read.get(Field.high)),
    low: yield* numberOf(read.get(Field.low)),
    open: yield* numberOf(read.get(Field.open)),
    change: yield* numberOf(change?.get(ChangeField.value)),
    changePercent: yield* numberOf(change?.get(ChangeField.percent)),
    regularBoard: board === undefined || board === REGULAR_BOARD,
  }
  return price
})

// A frame on top of the code's last: a frame carrying only the totals keeps
// the last price, previous close, range and change as last sent, so what the
// store keeps per code is whole. A frame with a last price and no change
// keeps none: Stockbit leaves a zero change out, and the readers work a
// missing change out from the last price and the previous close.
export const mergedLivePrice = Effect.fnUntraced(function* (
  held: LivePrice | undefined,
  price: LivePrice
): Effect.fn.Return<LivePrice> {
  if (held === undefined) return price
  const totalsOnly = price.last === undefined
  return {
    ...price,
    last: price.last ?? held.last,
    previous: price.previous ?? held.previous,
    high: price.high ?? held.high,
    low: price.low ?? held.low,
    open: price.open ?? held.open,
    change: totalsOnly ? (price.change ?? held.change) : price.change,
    changePercent: totalsOnly
      ? (price.changePercent ?? held.changePercent)
      : price.changePercent,
  }
})

// The `liveprice` frames in one connection's frames that belong to `date`.
export const stockbitLivePrices = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<Uint8Array>
) {
  const prices: Array<LivePrice> = []
  for (const bytes of yield* messagesIn(frames, LIVEPRICE)) {
    const price = yield* livePriceOf(bytes)
    if (price !== undefined && (yield* wibDateAt(price.time)) === date)
      prices.push(price)
  }
  return prices
})
