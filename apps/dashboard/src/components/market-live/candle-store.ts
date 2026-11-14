import type { Candle, Footprint, StockCode, ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"

// What changed since the listener last heard: everything (a fresh snapshot),
// or these candles and footprints, each whole.
export type CandleChange =
  | { readonly _tag: "Reset" }
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
        for (const [minute, candle] of byMinuteOf(mine))
          candles.set(minute, candle)
        for (const [minute, footprint] of byMinuteOf(cells))
          footprints.set(minute, footprint)
        emit({ _tag: "Update", candles: mine, footprints: cells })
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
