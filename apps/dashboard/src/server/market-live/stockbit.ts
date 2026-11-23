// Stockbit's protobuf frames into running trades (spec apinrdw/kumora#138,
// "Decoding (Worker-side)"). The schema is `securities.transactional.datafeed.v1`
// from Stockbit's public bundle; only the fields Market Live reads are decoded,
// by field number, and a frame that isn't a running trade batch is skipped:
// indicative.ts reads `iepiev` and stockbit-liveprice.ts `liveprice` with the
// same reader.
import {
  SHARES_PER_LOT,
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
// The cursor and its reads stay plain functions, not Effects: they
// step through every frame on the hot path, and as Effects decoding 100,000
// running trades took 745 ms, not 385 ms (about 120 ns a yielded Effect).
// `fieldsOf` wraps one message's loop in one Effect. See apinrdw/kumora#159.
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
const fieldsOf = (bytes: Uint8Array) =>
  Effect.sync((): ReadonlyArray<Field> | undefined => {
    const reader = readerOf(bytes)
    const fields: Array<Field> = []
    while (!reader.done()) {
      const key = reader.varint()
      const value = key === undefined ? undefined : reader.value(key % 8)
      if (key === undefined || value === undefined) return undefined
      fields.push({ number: Math.floor(key / 8), value })
    }
    return fields
  })

export const bytesOf = (value: Value | undefined) =>
  Effect.succeed(value instanceof Uint8Array ? value : undefined)
export const numberOf = (value: Value | undefined) =>
  Effect.succeed(typeof value === "number" ? value : undefined)

// A length-delimited field read as UTF-8 text.
export const textOf = Effect.fnUntraced(function* (value: Value | undefined) {
  const run = yield* bytesOf(value)
  return run === undefined ? undefined : new TextDecoder().decode(run)
})

// One message's fields by number, the first of each, or undefined when the
// bytes don't parse.
export const fieldReader = (bytes: Uint8Array) =>
  Effect.map(fieldsOf(bytes), (fields) => {
    if (fields === undefined) return undefined
    const byNumber = new Map<number, Value>()
    for (const field of fields)
      if (!byNumber.has(field.number)) byNumber.set(field.number, field.value)
    return byNumber as ReadonlyMap<number, Value>
  })

// The embedded messages in field `number` of a message.
const messagesAt = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  number: number
) {
  const messages: Array<Uint8Array> = []
  for (const field of (yield* fieldsOf(bytes)) ?? []) {
    const message = yield* bytesOf(field.value)
    if (field.number === number && message !== undefined) messages.push(message)
  }
  return messages
})

// The embedded messages in field `number` of every message in `frames`.
export const messagesIn = Effect.fnUntraced(function* (
  frames: ReadonlyArray<Uint8Array>,
  number: number
) {
  const messages: Array<Uint8Array> = []
  for (const frame of frames)
    messages.push(...(yield* messagesAt(frame, number)))
  return messages
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
const sideOf = (action: number | undefined) =>
  Effect.succeed<RunningTrade["side"]>(
    action === 1 ? "buy" : action === 2 ? "sell" : "none"
  )

// `BoardType`: 1 RG, 2 TN, 3 NG.
const BOARDS: Record<number, RunningTrade["board"]> = {
  1: "RG",
  2: "TN",
  3: "NG",
}

const isStockCode = Schema.is(StockCode)

// `google.protobuf.Timestamp`, to the millisecond the tape carries.
const instantOf = Effect.fnUntraced(function* (bytes: Uint8Array | undefined) {
  if (bytes === undefined) return undefined
  const read = yield* fieldReader(bytes)
  if (read === undefined) return undefined
  const seconds = (yield* numberOf(read.get(1))) ?? 0
  const nanos = (yield* numberOf(read.get(2))) ?? 0
  return DateTime.makeUnsafe(seconds * 1000 + Math.floor(nanos / 1e6))
})

// One `RunningTrade`, or undefined when a field the tape needs is missing.
const tradeOf = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const read = yield* fieldReader(bytes)
  if (read === undefined) return undefined
  const code = new TextDecoder().decode(yield* bytesOf(read.get(Trade.stock)))
  const price = yield* numberOf(read.get(Trade.price))
  const volume = yield* numberOf(read.get(Trade.volume))
  const tradeNumber = yield* numberOf(read.get(Trade.tradeNumber))
  const time = yield* instantOf(yield* bytesOf(read.get(Trade.time)))
  const board = BOARDS[(yield* numberOf(read.get(Trade.marketBoard))) ?? 0]
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
    // Volume is in shares; a lot is SHARES_PER_LOT shares. A negotiated print can be an odd lot.
    lots: volume / SHARES_PER_LOT,
    side: yield* sideOf(yield* numberOf(read.get(Trade.action))),
    board,
    feeds: ["Stockbit"],
  }
  return trade
})

// The running trades in one connection's frames that belong to `date`.
// Stockbit's trade number is already the bare daily sequence.
export const stockbitTrades = Effect.fnUntraced(function* (
  date: WibDate,
  frames: ReadonlyArray<Uint8Array>
) {
  const today: Array<RunningTrade> = []
  for (const batch of yield* messagesIn(frames, RUNNING_TRADE_BATCH))
    for (const bytes of yield* messagesAt(batch, BATCH_TRADE)) {
      const trade = yield* tradeOf(bytes)
      if (trade !== undefined && (yield* wibDateAt(trade.time)) === date)
        today.push(trade)
    }
  return today
})
