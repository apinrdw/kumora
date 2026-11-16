import type { MarketPhase } from "@workspace/relay"
import { Effect } from "effect"
import { useEffect, useMemo, useState } from "react"

import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import {
  bubblesOf,
  windowEnd,
  type BubbleFigures,
  type BubbleView,
  type MarketFlow,
} from "@/lib/bubbles"

// Figures recompute and bubbles re-target this often (spec
// apinrdw/kumora#427, "Cadence").
const RECOMPUTE_MS = 1000

// What a map shows each second: the bubbles and where the windows end, or
// none before the day's first trade.
export type BubbleFrame =
  | { readonly _tag: "Waiting" }
  | {
      readonly _tag: "Shown"
      readonly bubbles: ReadonlyArray<BubbleFigures>
      readonly end: number
      readonly closed: boolean
    }
  | { readonly _tag: "Empty" }

const WAITING: BubbleFrame = { _tag: "Waiting" }

// Cuts the ranked bubbles to the ones a map shows: a sector, the panel's
// set. It filters after the ranking, so a cut shows its codes of the
// market's Top N.
export type BubbleCut = (
  ranked: ReadonlyArray<BubbleFigures>
) => Effect.Effect<ReadonlyArray<BubbleFigures>>

// The bubbles of `view` cut by `cut` each RECOMPUTE_MS, and at once when
// either changes. The windows end at now on Market Live's clock,
// `clockOffset` ms ahead of the browser's, or at the day's last trade out of
// session.
export function useBubbleFrame(
  flow: MarketFlow,
  view: BubbleView,
  cut: BubbleCut,
  phase: MarketPhase | undefined,
  clockOffset: number
): BubbleFrame {
  const [frame, setFrame] = useState<BubbleFrame>(WAITING)
  useEffect(() => {
    if (phase === undefined) return
    const recompute = () => {
      const ends = Effect.runSync(
        windowEnd(flow, phase, Date.now() + clockOffset)
      )
      if (ends === undefined) return setFrame({ _tag: "Empty" })
      const ranked = Effect.runSync(bubblesOf(flow, view, ends.end))
      setFrame({ _tag: "Shown", bubbles: Effect.runSync(cut(ranked)), ...ends })
    }
    recompute()
    const timer = setInterval(recompute, RECOMPUTE_MS)
    return () => clearInterval(timer)
  }, [flow, view, cut, phase, clockOffset])
  return frame
}

// Each listed code's company name, for the tooltip.
export function useCodeNames(list: StockCodeList) {
  return useMemo(
    () =>
      new Map(
        list._tag === "Ready"
          ? list.codes.map(({ code, name }) => [code, name] as const)
          : []
      ),
    [list]
  )
}
