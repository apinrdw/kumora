import type { Candle, Footprint, StockCode, ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"

// What changed since the listener last heard: everything (a fresh snapshot),
// these candles and footprints, each whole, or a minute dropped with whatever
// else its delta carried, which a chart redraws whole for, its view kept.
export type CandleChange =
  | { readonly _tag: "Reset" }
  | { readonly _tag: "Dropped" }
  | {
      readonly _tag: "Update"
      readonly candles: ReadonlyArray<Candle>
      readonly footprints: ReadonlyArray<Footprint>
    }

export interface CandleStore {
  readonly code: StockCode
  // The selected code's candles, ascending by minute.
  readonly candles: () => ReadonlyArray<Candle>
  // The selected code's footprints, ascending by minute: chart 2's cells.
  readonly footprints: () => ReadonlyArray<Footprint>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: (change: CandleChange) => void) => () => void
}

// The selected code's candles and footprints from the viewer socket, outside
// React: the charts read them once when they mount and then hear each
// change, so a trade never re-renders the page. A snapshot of this code
// replaces them, and one answering an earlier Select of another code changes
// nothing; a delta's candles and footprints of this code replace theirs by
// minute.
//
// Decision: a footprint with no cells says its minute's last regular-board
// trade left it (candles.ts, `takeChanged`). The store drops that minute's
// footprint, and its candle unless the same delta carries one, and says
// Dropped: a chart can't take one bar back. See apinrdw/kumora#279.
export const makeCandleStore = (code: StockCode) =>
  Effect.sync((): CandleStore => {
    const byMinuteOf = <A extends { readonly minute: DateTime.Utc }>(
      rows: ReadonlyArray<A>
    ) => new Map(rows.map((row) => [DateTime.toEpochMillis(row.minute), row]))
    const ascending = <A>(byMinute: ReadonlyMap<number, A>) =>
      [...byMinute.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
    let candles = new Map<number, Candle>()
    let footprints = new Map<number, Footprint>()
    const listeners = new Set<(change: CandleChange) => void>()
    const emit = (change: CandleChange) => {
      for (const listener of listeners) listener(change)
    }
    return {
      code,
      candles: () => ascending(candles),
      footprints: () => ascending(footprints),
      apply: (message) => {
        if (message._tag === "Snapshot") {
          if (message.selected !== code) return
          candles = byMinuteOf(message.candles)
          footprints = byMinuteOf(message.footprints)
          emit({ _tag: "Reset" })
          return
        }
        const mine = message.candles.filter((candle) => candle.code === code)
        const cells = (message.footprints ?? []).filter(
          (footprint) => footprint.code === code
        )
        if (mine.length === 0 && cells.length === 0) return
        const carried = byMinuteOf(mine)
        for (const [minute, candle] of carried) candles.set(minute, candle)
        for (const [minute, footprint] of byMinuteOf(cells))
          footprints.set(minute, footprint)
        const emptied = cells.filter(
          (footprint) => footprint.cells.length === 0
        )
        for (const minute of byMinuteOf(emptied).keys()) {
          footprints.delete(minute)
          if (!carried.has(minute)) candles.delete(minute)
        }
        emit(
          emptied.length > 0
            ? { _tag: "Dropped" }
            : { _tag: "Update", candles: mine, footprints: cells }
        )
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
