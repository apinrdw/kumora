// Stockbit's protobuf frames into running trades (spec apinrdw/kumora#138,
// "Decoding (Worker-side)"). The schema is `securities.transactional.datafeed.v1`
// from Stockbit's public bundle; only the fields Market Live reads are decoded,
// by field number, and a frame that isn't a running trade batch is skipped:
// other tickets decode `liveprice`, `order_book` and `iepiev`.
import {
  StockCode,
  TradeNumber,
  wibDateAt,
  type RunningTrade,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

// A field's payload by wire type: a varint, a double (64-bit), a
// length-delimited byte run, or a float (32-bit).
type Value = number | Uint8Array

interface Field {
  readonly number: number
  readonly value: Value
}

// A cursor over one message's bytes. Each read returns undefined when the
// bytes end early. Varints are read as numbers: the fields read here
// (seconds, nanos, enums, the daily trade sequence) stay far below 2^53.
const readerOf = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const take = (length: number) => {
    if (at + length > bytes.length) return undefined
    at += length
    return at - length
  }
  const varint = (): number | undefined => {
    let value = 0
    for (let shift = 0; shift < 64 && at < bytes.length; shift += 7) {
      const byte = bytes[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
    }
    return undefined
  }
  const run = (length: number | undefined) => {
    const start = length === undefined ? undefined : take(length)
    return start === undefined ? undefined : bytes.subarray(start, at)
  }
  const fixed = (length: 4 | 8) => {
    const start = take(length)
    if (start === undefined) return undefined
    return length === 8
      ? view.getFloat64(start, true)
      : view.getFloat32(start, true)
  }
  // A field's payload by wire type: a varint, a double, a length-delimited
  // run, or a float. Groups (3 and 4) are not in the schema.
  const value = (wire: number): Value | undefined => {
    if (wire === 0) return varint()
    if (wire === 1) return fixed(8)
    if (wire === 2) return run(varint())
    if (wire === 5) return fixed(4)
    return undefined
  }
  return { done: () => at >= bytes.length, varint, value }
}

// Every field of one message, in wire order, or undefined when the bytes
// don't parse.
const fieldsOf = (bytes: Uint8Array): ReadonlyArray<Field> | undefined => {
  const reader = readerOf(bytes)
  const fields: Array<Field> = []
  while (!reader.done()) {
    const key = reader.varint()
    const value = key === undefined ? undefined : reader.value(key % 8)
    if (key === undefined || value === undefined) return undefined
    fields.push({ number: Math.floor(key / 8), value })
  }
  return fields
}

const bytesOf = (value: Value | undefined) =>
  value instanceof Uint8Array ? value : undefined
const numberOf = (value: Value | undefined) =>
  typeof value === "number" ? value : undefined

// The embedded messages in field `number` of a message.
const messagesAt = (bytes: Uint8Array, number: number) =>
  (fieldsOf(bytes) ?? []).flatMap((field) => {
    const message = bytesOf(field.value)
    return field.number === number && message !== undefined ? [message] : []
  })

// `WebsocketWrapMessageChannel`, the inbound wrapper: case 8 is
// `running_trade_batch`, whose field 1 repeats `RunningTrade`.
const RUNNING_TRADE_BATCH = 8
const BATCH_TRADE = 1

// `RunningTrade`'s fields. Field 1 is the socket's own timestamp; the trade's
// is field 7.
const Trade = {
  stock: 2,
  price: 3,
  volume: 4,
  action: 5,
  time: 7,
  tradeNumber: 9,
  marketBoard: 10,
} as const

// `TradeType`: 1 buy aggressor, 2 sell aggressor, anything else unspecified
// (auction matches and negotiated prints send none).
const sideOf = (action: number | undefined): RunningTrade["side"] =>
  action === 1 ? "buy" : action === 2 ? "sell" : "none"

// `BoardType`: 1 RG, 2 TN, 3 NG.
const BOARDS: Record<number, RunningTrade["board"]> = {
  1: "RG",
  2: "TN",
  3: "NG",
}

const isStockCode = Schema.is(StockCode)

// `google.protobuf.Timestamp`, to the millisecond the tape carries.
const instantOf = (bytes: Uint8Array | undefined) => {
  if (bytes === undefined) return undefined
  const fields = fieldsOf(bytes)
  if (fields === undefined) return undefined
  const part = (number: number) =>
    numberOf(fields.find((field) => field.number === number)?.value) ?? 0
  return DateTime.makeUnsafe(part(1) * 1000 + Math.floor(part(2) / 1e6))
}

// One `RunningTrade`, or undefined when a field the tape needs is missing.
const tradeOf = (bytes: Uint8Array) => {
  const fields = fieldsOf(bytes)
  if (fields === undefined) return undefined
  const read = (number: number) =>
    fields.find((field) => field.number === number)?.value
  const code = new TextDecoder().decode(bytesOf(read(Trade.stock)))
  const price = numberOf(read(Trade.price))
  const volume = numberOf(read(Trade.volume))
  const tradeNumber = numberOf(read(Trade.tradeNumber))
  const time = instantOf(bytesOf(read(Trade.time)))
  const board = BOARDS[numberOf(read(Trade.marketBoard)) ?? 0]
  if (
    !isStockCode(code) ||
    price === undefined ||
    volume === undefined ||
    tradeNumber === undefined ||
    time === undefined ||
    board === undefined
  )
    return undefined
  const trade: RunningTrade = {
    tradeNumber: TradeNumber.make(String(tradeNumber)),
    time,
    code,
    price,
    // Volume is in shares; a lot is 100. A negotiated print can be an odd lot.
    lots: volume / 100,
    side: sideOf(numberOf(read(Trade.action))),
    board,
    feeds: ["Stockbit"],
  }
  return trade
}

// The running trades in one connection's frames that belong to `date`.
// Stockbit's trade number is already the bare daily sequence.
export const stockbitTrades = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<Uint8Array>
) {
  const trades = frames
    .flatMap((frame) => messagesAt(frame, RUNNING_TRADE_BATCH))
    .flatMap((batch) => messagesAt(batch, BATCH_TRADE))
    .flatMap((bytes) => tradeOf(bytes) ?? [])
  const today: Array<RunningTrade> = []
  for (const trade of trades) {
    if ((yield* wibDateAt(trade.time)) === date) today.push(trade)
  }
  return today
})
