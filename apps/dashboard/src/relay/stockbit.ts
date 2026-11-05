// The slice of Stockbit's datafeed protobuf the tape needs, read by field
// number from the descriptors in docs/research/stockbit-capture/datafeed-schema.json
// (research/stockbit-protocol).
// WebsocketWrapMessageChannel: 2 ping, 8 running_trade_batch, 9 liveprice.
// RunningTradeBatch: 1 batch (repeated RunningTrade).
// RunningTrade: 1 websocket_time, 2 stock, 3 price, 4 volume, 5 action,
// 6 is_global, 7 time, 8 change {1 value, 2 percentage}, 9 trade_number,
// 10 market_board, 11 value.
// LivePrice: 1 stock_code, 2 lastprice, 3 volume, 4 high, 5 low, 6 open, 7 frequency,
// 10 average, 11 date, 13 prev, 14 value, 16 order_verb, 17 quantity, 21 order_number,
// 22 match_number.

export type RawTrade = {
  stock: string
  price: number
  volume: number
  action: number
  time: string
  change: number
  tradeNumber: number
  board: number
  value: number
}

/** A figure absent from the frame is null. */
export type RawLivePrice = {
  stock: string
  date: string | null
  prev: number | null
  open: number | null
  high: number | null
  low: number | null
  average: number | null
  volume: number | null
  value: number | null
  frequency: number | null
  lastprice: number | null
  /** The maker's side: `S` is an offer, `B` a bid. */
  verb: string | null
  /** Shares. */
  quantity: number | null
  /** Exceeds 2^53, so it stays a string. */
  orderNumber: string | null
  /** The WIB date, then the zero-padded 10-digit `trade_number`. Exceeds 2^53 too. */
  matchNumber: string | null
}

export type WrapFrame =
  | {
      channel: "running_trade_batch"
      trades: ReadonlyArray<RawTrade>
      /** Trades in the batch whose bytes could not be walked. */
      undecodable: number
    }
  | { channel: "liveprice"; liveprice: RawLivePrice }
  | { channel: "ping" }
  | { channel: "other"; field: number }
  | { channel: "malformed" }

type Field = {
  no: number
  wire: number
  /** Loses digits above 2^53: such a varint is read from `raw`. */
  int: number
  bytes: Uint8Array
  /** A varint's own bytes. */
  raw: Uint8Array
}

const sized = (no: number, wire: number, bytes: Uint8Array): Field => ({
  no,
  wire,
  int: 0,
  bytes,
  raw: EMPTY,
})

export const fields = (buf: Uint8Array): Array<Field> => {
  const out: Array<Field> = []
  let pos = 0
  const varint = (): number => {
    let result = 0
    let scale = 1
    for (;;) {
      const byte = buf[pos++]
      if (byte === undefined) throw new Error("truncated varint")
      result += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return result
      scale *= 128
    }
  }
  // A short slice would read past itself: a subarray's DataView sees its parent.
  const take = (length: number): Uint8Array => {
    if (pos + length > buf.length) throw new Error("truncated field")
    const bytes = buf.subarray(pos, pos + length)
    pos += length
    return bytes
  }
  while (pos < buf.length) {
    const tag = varint()
    const no = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      const start = pos
      const int = varint()
      out.push({ no, wire, int, bytes: EMPTY, raw: buf.subarray(start, pos) })
    } else if (wire === 1) out.push(sized(no, wire, take(8)))
    else if (wire === 2) out.push(sized(no, wire, take(varint())))
    else if (wire === 5) out.push(sized(no, wire, take(4)))
    else throw new Error(`unsupported wire type ${wire}`)
  }
  return out
}

const EMPTY = new Uint8Array(0)
const text = new TextDecoder()

const digits = (raw: Uint8Array): string => {
  let result = 0n
  for (let i = raw.length - 1; i >= 0; i--)
    result = (result << 7n) | BigInt((raw[i] ?? 0) & 0x7f)
  return result.toString()
}

const double = (b: Uint8Array): number =>
  new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true)

const timestamp = (b: Uint8Array): string => {
  let seconds = 0
  let nanos = 0
  for (const f of fields(b)) {
    if (f.no === 1) seconds = f.int
    else if (f.no === 2) nanos = f.int
  }
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6)).toISOString()
}

const tradeChange = (b: Uint8Array): number => {
  let change = 0
  for (const c of fields(b)) if (c.no === 1) change = double(c.bytes)
  return change
}

const TRADE_FIELDS: Record<number, (t: RawTrade, f: Field) => void> = {
  2: (t, f) => (t.stock = text.decode(f.bytes)),
  3: (t, f) => (t.price = double(f.bytes)),
  4: (t, f) => (t.volume = double(f.bytes)),
  5: (t, f) => (t.action = f.int),
  7: (t, f) => (t.time = timestamp(f.bytes)),
  8: (t, f) => (t.change = tradeChange(f.bytes)),
  9: (t, f) => (t.tradeNumber = f.int),
  10: (t, f) => (t.board = f.int),
  11: (t, f) => (t.value = double(f.bytes)),
}

const runningTrade = (b: Uint8Array): RawTrade => {
  const t: RawTrade = {
    stock: "",
    price: 0,
    volume: 0,
    action: 0,
    time: "",
    change: 0,
    tradeNumber: 0,
    board: 0,
    value: 0,
  }
  for (const f of fields(b)) TRADE_FIELDS[f.no]?.(t, f)
  return t
}

const LIVE_PRICE_FIELDS: Record<number, (p: RawLivePrice, f: Field) => void> = {
  1: (p, f) => (p.stock = text.decode(f.bytes)),
  2: (p, f) => (p.lastprice = double(f.bytes)),
  3: (p, f) => (p.volume = double(f.bytes)),
  4: (p, f) => (p.high = double(f.bytes)),
  5: (p, f) => (p.low = double(f.bytes)),
  6: (p, f) => (p.open = double(f.bytes)),
  7: (p, f) => (p.frequency = double(f.bytes)),
  10: (p, f) => (p.average = double(f.bytes)),
  11: (p, f) => (p.date = text.decode(f.bytes)),
  13: (p, f) => (p.prev = double(f.bytes)),
  14: (p, f) => (p.value = double(f.bytes)),
  16: (p, f) => (p.verb = text.decode(f.bytes)),
  17: (p, f) => (p.quantity = f.int),
  21: (p, f) => (p.orderNumber = digits(f.raw)),
  22: (p, f) => (p.matchNumber = digits(f.raw)),
}

const livePrice = (b: Uint8Array): RawLivePrice => {
  const p: RawLivePrice = {
    stock: "",
    date: null,
    prev: null,
    open: null,
    high: null,
    low: null,
    average: null,
    volume: null,
    value: null,
    frequency: null,
    lastprice: null,
    verb: null,
    quantity: null,
    orderNumber: null,
    matchNumber: null,
  }
  for (const f of fields(b)) LIVE_PRICE_FIELDS[f.no]?.(p, f)
  return p
}

/** Decodes one frame Stockbit's datafeed socket sent the page. Never throws. */
export const decodeWrap = (buf: Uint8Array): WrapFrame => {
  let wrap: Array<Field>
  try {
    wrap = fields(buf)
  } catch {
    return { channel: "malformed" }
  }
  const [first] = wrap
  if (!first) return { channel: "other", field: 0 }
  if (first.no === 2) return { channel: "ping" }
  if (first.no === 9) {
    try {
      const liveprice = livePrice(first.bytes)
      return liveprice.stock
        ? { channel: "liveprice", liveprice }
        : { channel: "malformed" }
    } catch {
      return { channel: "malformed" }
    }
  }
  if (first.no !== 8) return { channel: "other", field: first.no }
  let batch: Array<Field>
  try {
    batch = fields(first.bytes)
  } catch {
    return { channel: "malformed" }
  }
  const trades: Array<RawTrade> = []
  let undecodable = 0
  for (const f of batch) {
    if (f.no !== 1) continue
    try {
      trades.push(runningTrade(f.bytes))
    } catch {
      undecodable++
    }
  }
  return { channel: "running_trade_batch", trades, undecodable }
}

/**
 * First byte of the extension's message of coalesced `liveprice` frames.
 * `COALESCED` in apps/stockbit-relay-extension/src/liveprice.ts is a copy, and names this.
 */
export const COALESCED = 0x00

/** Splits `0x00` then repeated `[u32le length][frame]`. Never throws. */
export const unpackCoalesced = (
  message: Uint8Array
): { frames: Array<Uint8Array>; truncated: boolean } => {
  const view = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength
  )
  const frames: Array<Uint8Array> = []
  let pos = 1
  while (pos < message.length) {
    if (pos + 4 > message.length) return { frames, truncated: true }
    const length = view.getUint32(pos, true)
    pos += 4
    if (pos + length > message.length) return { frames, truncated: true }
    frames.push(message.subarray(pos, pos + length))
    pos += length
  }
  return { frames, truncated: false }
}
