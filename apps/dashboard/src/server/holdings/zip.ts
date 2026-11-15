// Reads a zip's entries by hand: its central directory, then workerd's
// DecompressionStream for a deflated entry. It handles what IDX's .xlsx
// reports and KSEI's .zip files are: stored or deflated entries, no ZIP64.
import { Effect, Schema, Stream } from "effect"

import { collectCapped } from "../archive/capped-body.ts"

class ZipUnreadable extends Schema.TaggedError<ZipUnreadable>()(
  "ZipUnreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) => new ZipUnreadable({ message })

// Decision: an entry inflates to at most 8 MiB, counted as it inflates, so a
// small archived file can't expand past the Worker's 128 MiB. The largest
// real entries are about 3× under it: IDX's sheet1.xml at 2.6 MB and KSEI's
// Balancepos .txt at 530 KB (Sep and Oct 2026).
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

// Decision: a zip's central directory takes at most 64 KiB, which bounds
// the entries and names it decodes whatever their count. IDX's .xlsx lists
// 23 files in about 2 KB, KSEI's .zip one (Oct 2026).
const MAX_DIRECTORY_BYTES = 64 * 1024

interface Entry {
  readonly method: number
  readonly size: number
  readonly offset: number
}

// The zip's entries by name, from the End of Central Directory record back,
// which a zip comment of at most 64 KiB may follow.
export const zipEntries = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const last = Math.max(0, bytes.length - 22 - 0xffff)
  let eocd = bytes.length - 22
  while (eocd >= last && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < last) return yield* unreadable("The file isn't a zip")
  const directoryBytes = view.getUint32(eocd + 12, true)
  if (directoryBytes > MAX_DIRECTORY_BYTES)
    return yield* unreadable(
      `The zip's directory is over ${MAX_DIRECTORY_BYTES.toLocaleString("en-US")} bytes`
    )
  const entries = new Map<string, Entry>()
  let at = view.getUint32(eocd + 16, true)
  const end = Math.min(at + directoryBytes, bytes.length)
  const count = view.getUint16(eocd + 10, true)
  const names = new TextDecoder()
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      return yield* unreadable("The file isn't a zip")
    const nameLength = view.getUint16(at + 28, true)
    const next =
      at +
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    if (next > end || local + 30 > bytes.length)
      return yield* unreadable("The file isn't a zip")
    entries.set(names.decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset:
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true),
    })
    at = next
  }
  return entries as ReadonlyMap<string, Entry>
})

// The text of the entry `name`, inflated, refused past `maxBytes`.
export const entryText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  entries: ReadonlyMap<string, Entry>,
  name: string,
  maxBytes = MAX_ENTRY_BYTES
) {
  const entry = entries.get(name)
  if (entry === undefined) return yield* unreadable(`The file has no ${name}`)
  const raw = bytes.slice(entry.offset, entry.offset + entry.size)
  if (entry.method !== 0 && entry.method !== 8)
    return yield* unreadable(
      `${name} uses zip compression method ${entry.method}`
    )
  const inflated = yield* collectCapped(
    entry.method === 0
      ? Stream.make(raw)
      : Stream.fromReadableStream({
          evaluate: () =>
            new Blob([raw])
              .stream()
              .pipeThrough(new DecompressionStream("deflate-raw")),
          onError: () => unreadable(`${name} doesn't inflate`),
        }),
    maxBytes,
    () => unreadable(`${name} inflates past ${maxBytes} bytes`)
  )
  return new TextDecoder().decode(inflated)
})
