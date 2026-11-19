// A cold day's order books (spec apinrdw/kumora#556, "The layout"): one R2
// object per recorded code, its stored gzip book chunks one after another
// behind a minute index, so a Book GET reads the index and one range.
//
// Layout, little-endian: the chunk count n (u32), then n entries of the
// chunk's minute (u32, minutes since the epoch) and the byte its chunk ends
// at (u32, counted from the end of the index), ascending by minute; then the
// chunks.
import { MINUTE_MS } from "@workspace/relay"
import { Effect } from "effect"

// A code's stored chunk: its minute (epoch ms) and its gzip bytes, as
// `book_chunks` holds them.
export interface StoredBookChunk {
  readonly minute: number
  readonly chunk: Uint8Array
}

const ENTRY_BYTES = 8
const COUNT_BYTES = 4

// Decision: `book_chunks` keys a chunk by code and minute, so a code's index
// is never longer than a day's minutes' worth of entries. The read asks for
// that much from the start of the object in one range, which R2 cuts to the
// object's size, and so needs no read of the count first.
const MOST_CHUNKS = 24 * 60
export const BOOK_INDEX_BYTES = COUNT_BYTES + MOST_CHUNKS * ENTRY_BYTES

// One code's object: its chunks, ascending by minute, behind their index.
export const packBook = (chunks: ReadonlyArray<StoredBookChunk>) =>
  Effect.sync(() => {
    const start = COUNT_BYTES + chunks.length * ENTRY_BYTES
    const size = chunks.reduce((sum, { chunk }) => sum + chunk.length, start)
    const packed = new Uint8Array(size)
    const view = new DataView(packed.buffer)
    view.setUint32(0, chunks.length, true)
    let end = 0
    for (const [index, { minute, chunk }] of chunks.entries()) {
      packed.set(chunk, start + end)
      end += chunk.length
      const entry = COUNT_BYTES + index * ENTRY_BYTES
      view.setUint32(entry, minute / MINUTE_MS, true)
      view.setUint32(entry + 4, end, true)
    }
    return packed
  })

// The byte range of the chunk in force at `minute` (epoch ms), the one for
// that minute or the latest before it, read from the object's first bytes;
// none before the code's first chunk.
export const chunkRange = (head: Uint8Array, minute: number) =>
  Effect.sync(() => {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const count = view.getUint32(0, true)
    const start = COUNT_BYTES + count * ENTRY_BYTES
    const wanted = minute / MINUTE_MS
    let found: number | undefined
    for (let index = 0; index < count; index++) {
      if (view.getUint32(COUNT_BYTES + index * ENTRY_BYTES, true) > wanted)
        break
      found = index
    }
    if (found === undefined) return undefined
    const endOf = (index: number) =>
      view.getUint32(COUNT_BYTES + index * ENTRY_BYTES + 4, true)
    const from = found === 0 ? 0 : endOf(found - 1)
    return { offset: start + from, length: endOf(found) - from }
  })
