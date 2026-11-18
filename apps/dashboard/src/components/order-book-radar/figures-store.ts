import type { StockCode, ViewerDown } from "@workspace/relay"
import { Effect } from "effect"

import type { CodeFigures } from "@/lib/order-book-radar"

export interface FiguresStore {
  readonly all: () => ReadonlyMap<StockCode, CodeFigures>
  readonly apply: (message: ViewerDown) => void
}

// Every code's scanner figures from the viewer socket, outside React. A
// snapshot replaces them all and a delta replaces those of the codes it
// carries: the object sends each code whose figures changed, so the store
// takes nothing else, a delta's candles included. It has no subscribe: no
// row shows its figures. The ranking reads them at each re-sort
// (use-ranking.ts), so a moved last price takes effect there, and alerts
// read them at each match.
export const makeFiguresStore = Effect.sync((): FiguresStore => {
  let held = new Map<StockCode, CodeFigures>()
  return {
    all: () => held,
    apply: (message) => {
      if (message._tag === "Snapshot") held = new Map()
      for (const { code, ...figures } of message.scannerFigures ?? [])
        held.set(code, figures)
    },
  }
})
