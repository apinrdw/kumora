import { readFileSync } from "node:fs"

import { varint } from "@/relay/upstream"

/* A small protobuf writer for frames the capture does not hold. */

const tag = (no: number, wire: number) => varint(no * 8 + wire)

const message = (no: number, body: ArrayLike<number>): Array<number> => [
  ...tag(no, 2),
  ...varint(body.length),
  ...Array.from(body),
]

const double = (no: number, value: number): Array<number> => [
  ...tag(no, 1),
  ...new Uint8Array(new Float64Array([value]).buffer),
]

const int = (no: number, value: number) => [...tag(no, 0), ...varint(value)]

/** A varint from its digits, for the numbers above 2^53. */
const bigVarint = (no: number, digits: string): Array<number> => {
  const out = tag(no, 0)
  let rest = BigInt(digits)
  while (rest > 0x7fn) {
    out.push(Number(rest & 0x7fn) | 0x80)
    rest >>= 7n
  }
  out.push(Number(rest))
  return out
}

export type WireTrade = {
  stock: string
  price?: number
  volume?: number
  action?: number
  time: string
  /** Left off the wire when undefined. */
  change?: number
  tradeNumber: number
  board?: number
  value?: number
}

export const wireTrade = (t: WireTrade): Array<number> => [
  ...message(2, new TextEncoder().encode(t.stock)),
  ...double(3, t.price ?? 100),
  ...double(4, t.volume ?? 100),
  ...int(5, t.action ?? 1),
  ...message(7, int(1, Math.floor(Date.parse(t.time) / 1000))),
  ...(t.change === undefined ? [] : message(8, double(1, t.change))),
  ...int(9, t.tradeNumber),
  ...int(10, t.board ?? 1),
  ...double(11, t.value ?? 10_000),
]

/** A whole `running_trade_batch` frame. */
export const wireBatch = (trades: ReadonlyArray<WireTrade>): Uint8Array =>
  new Uint8Array(
    message(
      8,
      trades.flatMap((t) => message(1, wireTrade(t)))
    )
  )

/** A whole `liveprice` frame, with the fields the day and the order turn on. */
export const wireLivePrice = (p: {
  stock: string
  date: string
  volume: number
  lastprice?: number
  verb?: string
  quantity?: number
  orderNumber?: string
  matchNumber?: string
}): Uint8Array =>
  new Uint8Array(
    message(9, [
      ...message(1, new TextEncoder().encode(p.stock)),
      ...double(3, p.volume),
      ...message(11, new TextEncoder().encode(p.date)),
      ...(p.lastprice === undefined ? [] : double(2, p.lastprice)),
      ...(p.verb === undefined
        ? []
        : message(16, new TextEncoder().encode(p.verb))),
      ...(p.quantity === undefined ? [] : int(17, p.quantity)),
      ...(p.orderNumber === undefined ? [] : bigVarint(21, p.orderNumber)),
      ...(p.matchNumber === undefined ? [] : bigVarint(22, p.matchNumber)),
    ])
  )

/** A batch holding one trade body of raw bytes between `before` and `after`. */
export const wireBatchWithRawTrade = (
  before: WireTrade,
  raw: ReadonlyArray<number>,
  after: WireTrade
): Uint8Array =>
  new Uint8Array(
    message(8, [
      ...message(1, wireTrade(before)),
      ...message(1, raw),
      ...message(1, wireTrade(after)),
    ])
  )

/** The received frames of the 2026-10-29 capture, in order. */
export const capturedFrames = (): Array<Uint8Array> =>
  readFileSync(
    new URL("../fixtures/stockbit/stockbit-frames.ndjson", import.meta.url),
    "utf8"
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { dir: string; b64?: string })
    .flatMap((e) =>
      e.dir === "recv" && e.b64
        ? [new Uint8Array(Buffer.from(e.b64, "base64"))]
        : []
    )
