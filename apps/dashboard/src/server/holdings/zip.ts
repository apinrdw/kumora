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

interface Entry {
  readonly method: number
  readonly size: number
  readonly offset: number
}

// The zip's entries by name, from the End of Central Directory record back.
export const zipEntries = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) return yield* unreadable("The file isn't a zip")
  const entries = new Map<string, Entry>()
  let at = view.getUint32(eocd + 16, true)
  const count = view.getUint16(eocd + 10, true)
  const names = new TextDecoder()
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return yield* unreadable("The file isn't a zip")
    const nameLength = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    if (local + 30 > bytes.length)
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
    at +=
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
  }
  return entries as ReadonlyMap<string, Entry>
})

// The text of the entry `name`, inflated, refused past MAX_ENTRY_BYTES.
export const entryText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  entries: ReadonlyMap<string, Entry>,
  name: string
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
    MAX_ENTRY_BYTES,
    () => unreadable(`${name} inflates past ${MAX_ENTRY_BYTES} bytes`)
  )
  return new TextDecoder().decode(inflated)
})
