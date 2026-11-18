import type { StockCode, ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { CodeFigures } from "@/lib/order-book-radar"

export interface FiguresStore {
  readonly all: () => ReadonlyMap<StockCode, CodeFigures>
  readonly apply: (message: ViewerDown) => void
}

// Every code's scanner figures from the viewer socket, outside React. A
// snapshot replaces them all; a delta's candles, every changed code's,
// move a code's last price to its newest minute's close. It has no
// subscribe: no row shows its figures. The ranking reads them at each
// re-sort (use-ranking.ts), so a moved last price takes effect there, and
// alerts read them at each match.
export const makeFiguresStore = Effect.sync((): FiguresStore => {
  let held = new Map<StockCode, CodeFigures>()
  // The minute each code's last price came from.
  let minutes = new Map<StockCode, number>()
  return {
    all: () => held,
    apply: (message) => {
      if (message._tag === "Snapshot") {
        held = new Map(
          (message.scannerFigures ?? []).map(({ code, ...figures }) => [
            code,
            figures,
          ])
        )
        minutes = new Map()
        return
      }
      for (const candle of message.candles) {
        const minute = DateTime.toEpochMillis(candle.minute)
        if (minute < (minutes.get(candle.code) ?? 0)) continue
        minutes.set(candle.code, minute)
        const before = held.get(candle.code)
        held.set(candle.code, {
          last: candle.close,
          previousClose: before?.previousClose,
          previousValue: before?.previousValue,
        })
      }
    },
  }
})
