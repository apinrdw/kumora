// A stock code's book heatmap row for one minute (spec apinrdw/kumora#263,
// "The trading-day Durable Object"): the six 10-second slices of its book
// chunk, worked out when the chunk closes (book-chunks.ts) and stored beside
// it (day-store.ts).
import {
  HEAT_SLICE_MS,
  encodeRecordedHeatmap,
  type BookDelta,
  type HeatLevel,
  type HeatSlice,
  type OrderBook,
  type StockCode,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { heatSlices, type BookChange } from "../../lib/heatmap.ts"

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

// A chunk's slices that end by `through`, all six by default.
export const chunkSlices = Effect.fnUntraced(function* (
  chunk: HeldChunk,
  through = chunk.minute + MINUTE_MS
) {
  const end = Math.min(chunk.minute + MINUTE_MS, through)
  return yield* heatSlices(yield* changesOf(chunk), chunk.minute, end)
})

// The stored text of a minute's slices: [slice index, levels] for each slice
// with lots.
export const slicesText = Effect.fnUntraced(function* (
  minute: number,
  slices: ReadonlyArray<HeatSlice>
) {
  return JSON.stringify(
    slices.map((slice) => [
      (DateTime.toEpochMillis(slice.at) - minute) / HEAT_SLICE_MS,
      slice.levels,
    ])
  )
})

// The store's own write, read back without a decode.
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

// One minute's slices, as stored or still held.
export interface HeatRow {
  readonly minute: number
  readonly slices: ReadonlyArray<HeatSlice>
}

// The heatmap GET's answer for `code`. A sealed day answers every stored row,
// through the end of the last. A live day answers up to the start of the
// slice `now` is in: the stored rows, then the held chunks' whole slices,
// which replace a stored minute of theirs.
export const heatmapAnswer = Effect.fnUntraced(function* (
  code: StockCode,
  stored: ReadonlyArray<HeatRow>,
  live:
    | {
        readonly now: number
        readonly held: (
          through: number
        ) => Effect.Effect<ReadonlyArray<HeatRow>>
      }
    | undefined
) {
  if (live === undefined)
    return yield* encodeRecordedHeatmap({
      code,
      through: DateTime.makeUnsafe(
        (stored.at(-1)?.minute ?? -MINUTE_MS) + MINUTE_MS
      ),
      slices: stored.flatMap((row) => row.slices),
    })
  const through = Math.floor(live.now / HEAT_SLICE_MS) * HEAT_SLICE_MS
  const rows = new Map(stored.map((row) => [row.minute, row.slices]))
  for (const row of yield* live.held(through)) rows.set(row.minute, row.slices)
  return yield* encodeRecordedHeatmap({
    code,
    through: DateTime.makeUnsafe(through),
    slices: [...rows]
      .sort(([a], [b]) => a - b)
      .flatMap(([, slices]) => slices)
      .filter((slice) => DateTime.toEpochMillis(slice.at) < through),
  })
})
