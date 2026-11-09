import type { Candle, StockCode, ViewerDown } from "@workspace/relay"
import { DateTime } from "effect"

// What changed since the listener last heard: every candle (a fresh snapshot),
// or these candles, each whole.
export type CandleChange =
  | { readonly _tag: "Reset" }
  | { readonly _tag: "Update"; readonly candles: ReadonlyArray<Candle> }

export interface CandleStore {
  readonly code: StockCode
  // The selected code's candles, ascending by minute.
  readonly candles: () => ReadonlyArray<Candle>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: (change: CandleChange) => void) => () => void
}

// The selected code's candles from the viewer socket, outside React: the chart
// reads them once when it mounts and then hears each change, so a trade never
// re-renders the page. A snapshot of this code replaces them, and one
// answering an earlier Select of another code changes nothing; a delta's
// candles of this code replace theirs by minute.
export function makeCandleStore(code: StockCode): CandleStore {
  let byMinute = new Map<number, Candle>()
  const listeners = new Set<(change: CandleChange) => void>()
  const emit = (change: CandleChange) => {
    for (const listener of listeners) listener(change)
  }
  return {
    code,
    candles: () =>
      [...byMinute.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, candle]) => candle),
    apply: (message) => {
      if (message._tag === "Snapshot") {
        if (message.selected !== code) return
        byMinute = new Map(
          message.candles.map((candle) => [
            DateTime.toEpochMillis(candle.minute),
            candle,
          ])
        )
        emit({ _tag: "Reset" })
        return
      }
      const mine = message.candles.filter((candle) => candle.code === code)
      if (mine.length === 0) return
      for (const candle of mine)
        byMinute.set(DateTime.toEpochMillis(candle.minute), candle)
      emit({ _tag: "Update", candles: mine })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
