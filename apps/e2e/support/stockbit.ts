import { readFileSync } from "node:fs"

import {
  doubleField,
  messageField,
  varintField,
} from "../../dashboard/tests/server/market-live/protobuf.ts"

import { marketNow } from "./clock"
import { wibToday } from "./ingest"

// Recorded Stockbit running trades from 2026-11-09, shared with the
// trading-day Durable Object's tests.
interface StockbitRow {
  readonly tradeWib: string
  readonly code: string
  readonly price: number
  readonly volume: number
  readonly action?: number
  readonly board: number
  readonly tradeNumber: number
}
const recorded: { readonly boards: ReadonlyArray<StockbitRow> } = JSON.parse(
  readFileSync(
    new URL(
      "../../dashboard/tests/server/market-live/fixtures/stockbit-trades-2026-11-09.json",
      import.meta.url
    ),
    "utf8"
  )
)

const runningTrade = (row: StockbitRow, date: string) => {
  const ms = Date.parse(`${date}T${row.tradeWib}+07:00`)
  return [
    ...messageField(2, [...new TextEncoder().encode(row.code)]),
    ...doubleField(3, row.price),
    ...doubleField(4, row.volume),
    ...(row.action === undefined ? [] : varintField(5, row.action)),
    ...messageField(7, [
      ...varintField(1, Math.floor(ms / 1000)),
      ...varintField(2, (ms % 1000) * 1_000_000),
    ]),
    ...varintField(9, row.tradeNumber),
    ...varintField(10, row.board),
  ]
}

/**
 * One `running_trade_batch` frame (wrapper case 8) of the recorded cash-board
 * trade 26320 (ENRG), moved to today and numbered `base` above 26320, as
 * Stockbit's socket sends it.
 */
export function stockbitTradeFrameToday(base = 0): Uint8Array {
  const today = wibToday()
  return Uint8Array.from(
    messageField(
      8,
      recorded.boards
        .filter((row) => row.tradeNumber === 26320)
        .flatMap((row) =>
          messageField(
            1,
            runningTrade({ ...row, tradeNumber: base + row.tradeNumber }, today)
          )
        )
    )
  )
}

/**
 * One IHSG `liveprice` frame (wrapper case 9) at `last`, as Stockbit's socket
 * sends an index's: the day's totals, no previous close and no change.
 */
export function stockbitIndexFrameNow(last: number): Uint8Array {
  return Uint8Array.from(
    messageField(9, [
      ...messageField(1, [...new TextEncoder().encode("IHSG")]),
      ...doubleField(2, last),
      ...doubleField(3, 24_187_023_700),
      ...doubleField(4, last),
      ...doubleField(5, last),
      ...doubleField(6, last),
      ...doubleField(7, 674_825),
      ...messageField(11, [
        ...new TextEncoder().encode(new Date(marketNow()).toISOString()),
      ]),
      ...doubleField(14, 4_224_616_955_900),
      ...varintField(18, 1),
    ])
  )
}

/**
 * One `orderbook` frame (wrapper case 10): one full side of `code`'s book,
 * levels of `[price, orders, lots]`, as Stockbit's socket sends it now.
 */
export function stockbitOrderBookFrame(
  code: string,
  side: "BID" | "OFFER",
  levels: ReadonlyArray<readonly [number, number, number]>
): Uint8Array {
  const shares = levels.map(([price, orders, lots]) => [
    price,
    orders,
    lots * 100,
  ])
  const orders = shares.reduce((sum, [, count]) => sum + count!, 0)
  const total = shares.reduce((sum, [, , count]) => sum + count!, 0)
  const body = [
    "#O",
    code,
    side,
    ...shares.map((level) => level.join(";")),
    `${Math.floor(marketNow() / 1000)}-${orders}&${total}`,
  ].join("|")
  const encode = (text: string) => [...new TextEncoder().encode(text)]
  return Uint8Array.from(
    messageField(10, [
      ...messageField(1, encode(code)),
      ...messageField(2, encode(body)),
      ...messageField(5, encode(new Date(marketNow()).toISOString())),
    ])
  )
}

const readVarint = (bytes: Uint8Array, at: number): [number, number] => {
  let value = 0
  let shift = 0
  let next = at
  for (;;) {
    const byte = bytes[next++]!
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return [value, next]
    shift += 7
  }
}

// A message's length-delimited fields, by field number.
const stringFields = (bytes: Uint8Array) => {
  const fields = new Map<number, Array<Uint8Array>>()
  let at = 0
  while (at < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, at)
    const [length, start] = readVarint(bytes, afterTag)
    const field = Math.floor(tag / 8)
    fields.set(field, [
      ...(fields.get(field) ?? []),
      bytes.subarray(start, start + length),
    ])
    at = start + length
  }
  return fields
}

const text = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes ?? new Uint8Array())

/**
 * The relay's Stockbit subscribe frame (a WebsocketRequest), read back: its
 * credentials and the codes listed on each channel.
 */
export function readSubscribe(frame: Uint8Array) {
  const request = stringFields(frame)
  const channel = stringFields(request.get(2)?.[0] ?? new Uint8Array())
  const codes = (field: number) => (channel.get(field) ?? []).map(text)
  return {
    userId: text(request.get(1)?.[0]),
    key: text(request.get(3)?.[0]),
    accessToken: text(request.get(5)?.[0]),
    orderBook: codes(2),
    runningTradeBatch: codes(5),
    liveprice: codes(6),
    iepiev: codes(7),
  }
}
