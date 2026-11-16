// Market Live's bubble panel (spec apinrdw/kumora#427, "The Market Live
// panel"): which codes it shows, over which windows, sized by value and
// coloured by Buy/Sell delta %.
import { INDEX_CODES, UNCLASSIFIED, type StockCode } from "@workspace/relay"
import { Effect } from "effect"

import type { SectorLookup } from "./bubble-sectors"
import type { BubbleFigures, BubbleView, BubbleWindow } from "./bubbles"

export const PANEL_SETS = ["top", "watchlist", "sector"] as const
export type PanelSet = (typeof PANEL_SETS)[number]

export const PANEL_WINDOWS = [
  "1m",
  "5m",
  "15m",
] as const satisfies ReadonlyArray<BubbleWindow>
export type PanelWindow = (typeof PANEL_WINDOWS)[number]

const PANEL_BUBBLES = 60

// The page's view the panel draws with: every code ranked, so a set picks
// its own 60 from the whole market.
export const panelView = (window: PanelWindow): BubbleView => ({
  size: "value",
  colour: "delta",
  window,
  top: "all",
})

// The set shown: an index has no sector, so Sector of selected shows the
// market top while one is selected.
export const panelSetOf = (set: PanelSet, selected: StockCode) =>
  Effect.succeed<PanelSet>(
    set === "sector" && INDEX_CODES.includes(selected) ? "top" : set
  )

// The set's codes of the ranked bubbles, largest first, at most 60: the
// market's, the watchlist's, or those of the selected code's sector.
export const panelBubbles = (
  ranked: ReadonlyArray<BubbleFigures>,
  set: PanelSet,
  {
    selected,
    watchlist,
    sectors,
  }: {
    readonly selected: StockCode
    readonly watchlist: ReadonlyArray<StockCode>
    readonly sectors: SectorLookup
  }
) =>
  Effect.gen(function* () {
    const shown = yield* panelSetOf(set, selected)
    const sectorOf = (code: StockCode) => sectors.get(code) ?? UNCLASSIFIED
    const keep =
      shown === "watchlist"
        ? (code: StockCode) => watchlist.includes(code)
        : shown === "sector"
          ? (code: StockCode) => sectorOf(code) === sectorOf(selected)
          : () => true
    return ranked.filter(({ code }) => keep(code)).slice(0, PANEL_BUBBLES)
  })
