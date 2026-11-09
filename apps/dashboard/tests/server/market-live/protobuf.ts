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
