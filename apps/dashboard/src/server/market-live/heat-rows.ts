// A stock code's book heatmap row for one minute (spec apinrdw/kumora#263,
// "The trading-day Durable Object"): the six 10-second slices of its book
// chunk (book-chunks.ts), worked out on read (day-store.ts, `heatmapOf`). A
// day recorded before that stored them beside each chunk. A minute with no
// frame has no chunk and no row: the heatmap GET's answer fills it from the
// chunk before.
import {
  HEAT_SLICE_MS,
  decodeBookChunk,
  encodeRecordedHeatmap,
  type BookDelta,
  type HeatLevel,
  type HeatSlice,
  type OrderBook,
  type StockCode,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect, type Schema } from "effect"

import {
  heatSlices,
  type BookChange,
  type RestingBook,
} from "../../lib/heatmap.ts"

// One code's chunk for one minute before it is encoded: the book in force
// when the minute began, if any, then each served frame's changed parts.
export interface HeldChunk {
  readonly minute: number
  readonly start: OrderBook | undefined
  readonly deltas: ReadonlyArray<BookDelta>
}

// The books a chunk held and when each came into force: its start at the
// minute, then each frame's book once served.
const changesOf = (chunk: HeldChunk) =>
  Effect.sync(() => {
    const changes: Array<BookChange> = []
    let book: { bids: OrderBook["bids"]; offers: OrderBook["offers"] } =
      chunk.start === undefined
        ? { bids: [], offers: [] }
        : { bids: chunk.start.bids, offers: chunk.start.offers }
    if (chunk.start !== undefined) changes.push({ at: chunk.minute, book })
    for (const delta of chunk.deltas) {
      book = {
        bids: delta.bids ?? book.bids,
        offers: delta.offers ?? book.offers,
      }
      changes.push({ at: DateTime.toEpochMillis(delta.servedAt), book })
    }
    return changes
  })

// A stored chunk's text as the chunk the object held.
export const heldChunkOf = Effect.fnUntraced(function* (text: string) {
  const chunk = yield* decodeBookChunk(text)
  return {
    minute: DateTime.toEpochMillis(chunk.minute),
    start: chunk.start,
    deltas: chunk.deltas,
  } satisfies HeldChunk
})

// The book a chunk ended with, in force until the code's next frame; none
// for a chunk that held no book.
export const endBookOf = (chunk: HeldChunk) =>
  Effect.map(changesOf(chunk), (changes) => changes.at(-1)?.book)

// The same of a stored chunk's text; none for a minute that stored no chunk.
export const storedEndBook = (text: string | undefined) =>
  text === undefined
    ? Effect.succeed(undefined)
    : Effect.flatMap(heldChunkOf(text), endBookOf)

// A chunk's slices that end by `through`, all six by default.
export const chunkSlices = Effect.fnUntraced(function* (
  chunk: HeldChunk,
  through = chunk.minute + MINUTE_MS
) {
  const end = Math.min(chunk.minute + MINUTE_MS, through)
  return yield* heatSlices(yield* changesOf(chunk), chunk.minute, end)
})

// A stored row's slices, [slice index, levels] for each slice with lots: the
// store's own write, read back without a decode.
export const slicesFromText = Effect.fnUntraced(function* (
  minute: number,
  text: string
) {
  const stored = JSON.parse(text) as ReadonlyArray<
    readonly [number, ReadonlyArray<HeatLevel>]
  >
  return stored.map(([index, levels]): HeatSlice => ({
    at: DateTime.makeUnsafe(minute + index * HEAT_SLICE_MS),
    levels,
  }))
})

// One minute's slices, as stored or still held, and the book its chunk
// ended with, read only when the minute after it has no row.
export interface HeatRow {
  readonly minute: number
  readonly slices: ReadonlyArray<HeatSlice>
  readonly endBook: Effect.Effect<RestingBook | undefined, Schema.SchemaError>
}

// Each row's slices, ascending by minute, and over the minutes with no row
// after it the book it ended with, up to the next row and `through` at most.
// Decision: a day stores no heatmap row; a GET works it out from book chunks
// (apps/dashboard/docs/adr/0086-heatmaps-are-worked-out-on-read-from-book-chunks.md)
const withFramelessMinutes = Effect.fnUntraced(function* (
  rows: ReadonlyArray<HeatRow>,
  through: number
) {
  const slices: Array<HeatSlice> = []
  for (const [index, row] of rows.entries()) {
    slices.push(...row.slices)
    const from = row.minute + MINUTE_MS
    const to = Math.min(rows[index + 1]?.minute ?? through, through)
    if (from >= to) continue
    const book = yield* row.endBook
    if (book !== undefined)
      slices.push(...(yield* heatSlices([{ at: from, book }], from, to)))
  }
  return slices
})

// The heatmap GET's answer for `code`, up to `end` at most, where the day's
// slices stop (`heatEndOf`). A sealed day answers its stored rows through
// `end`. A live day answers up to the start of the slice `now` is in: the
// stored rows, then the held chunks' whole slices, which replace a stored
// minute of theirs. A code whose book the day did not record, `notRecorded`,
// answers no slices and says so.
export const heatmapAnswer = Effect.fnUntraced(function* (
  code: StockCode,
  stored: ReadonlyArray<HeatRow>,
  end: number,
  live:
    | {
        readonly now: number
        readonly held: (
          through: number
        ) => Effect.Effect<ReadonlyArray<HeatRow>>
      }
    | undefined,
  notRecorded = false
) {
  const through =
    live === undefined
      ? end
      : Math.min(end, Math.floor(live.now / HEAT_SLICE_MS) * HEAT_SLICE_MS)
  const rows = new Map(stored.map((row) => [row.minute, row]))
  if (live !== undefined)
    for (const row of yield* live.held(through)) rows.set(row.minute, row)
  const slices = yield* withFramelessMinutes(
    [...rows.values()].sort((a, b) => a.minute - b.minute),
    through
  )
  return yield* encodeRecordedHeatmap({
    code,
    through: DateTime.makeUnsafe(through),
    slices: slices.filter(
      (slice) => DateTime.toEpochMillis(slice.at) < through
    ),
    ...(notRecorded ? { notRecorded: true as const } : {}),
  })
})
