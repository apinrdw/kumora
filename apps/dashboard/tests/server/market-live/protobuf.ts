// A test-only protobuf encoder for Stockbit frames: wire-format fields by
// number, as `securities.transactional.datafeed.v1` lays them out.
const varint = (value: number): Array<number> => {
  const bytes: Array<number> = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return bytes
}
export const varintField = (field: number, value: number) => [
  ...varint(field * 8),
  ...varint(value),
]
export const doubleField = (field: number, value: number) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, true)
  return [...varint(field * 8 + 1), ...bytes]
}
export const messageField = (field: number, bytes: ReadonlyArray<number>) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
]
export const stringField = (field: number, text: string) =>
  messageField(field, [...new TextEncoder().encode(text)])

// One running trade on 2026-11-09, as `securities.transactional.datafeed.v1`
// lays `RunningTrade` out: the time in WIB (HH:MM:SS.sss), the volume in
// shares, the action (1 buy, 2 sell) and the board (1 RG, 2 TN, 3 NG).
export interface StockbitRow {
  readonly tradeWib: string
  readonly code: string
  readonly price: number
  readonly volume: number
  readonly action?: number
  readonly board: number
  readonly tradeNumber: number
}

const runningTrade = (row: StockbitRow) => {
  const ms = Date.parse(`2026-11-09T${row.tradeWib}+07:00`)
  const timestamp = [
    ...varintField(1, Math.floor(ms / 1000)),
    ...varintField(2, (ms % 1000) * 1_000_000),
  ]
  return [
    ...messageField(2, [...new TextEncoder().encode(row.code)]),
    ...doubleField(3, row.price),
    ...doubleField(4, row.volume),
    ...(row.action === undefined ? [] : varintField(5, row.action)),
    ...messageField(7, timestamp),
    ...varintField(9, row.tradeNumber),
    ...varintField(10, row.board),
  ]
}

// A `running_trade_batch` frame (wrapper case 8) of `rows`.
export const runningTradeBatch = (rows: ReadonlyArray<StockbitRow>) =>
  Uint8Array.from(
    messageField(
      8,
      rows.flatMap((row) => messageField(1, runningTrade(row)))
    )
  )
