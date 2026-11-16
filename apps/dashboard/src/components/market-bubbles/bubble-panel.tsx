import { Link } from "@tanstack/react-router"
import type { StockCode } from "@workspace/relay"
import { INDEX_CODES } from "@workspace/relay"
import { Effect } from "effect"
import { useCallback, useMemo } from "react"

import { useMarketPhase } from "@/components/market-live/market-conditions"
import { useChartSettings } from "@/components/market-live/use-chart-settings"
import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import {
  PANEL_WINDOWS,
  panelBubbles,
  panelSetOf,
  panelView,
  type PanelSet,
} from "@/lib/bubble-panel"
import type { BubbleFigures, MarketFlow } from "@/lib/bubbles"
import { searchOfView } from "@/lib/market-bubbles-search"

import { BubbleCanvas } from "./bubble-canvas"
import { Pressed } from "./pressed"
import { useBubbleFrame, useCodeNames } from "./use-bubble-frame"
import { useSectors } from "./use-sectors"

const WINDOW_OPTIONS = PANEL_WINDOWS.map((window) => ({
  value: window,
  label: window,
}))

/**
 * Market Live's bubble panel (spec apinrdw/kumora#427, "The Market Live
 * panel"): up to 60 of the live day's codes by value, coloured by Buy/Sell
 * delta %, from the market top, the watchlist or the selected code's sector,
 * over 1m, 5m or 15m; this browser remembers both choices. A click selects
 * its code through `onSelect`, and the selected code is ringed.
 */
export function BubblePanel({
  flow,
  selected,
  watchlist,
  list,
  clockOffset,
  onSelect,
}: {
  flow: MarketFlow
  selected: StockCode
  watchlist: ReadonlyArray<StockCode>
  list: StockCodeList
  clockOffset: number
  onSelect: (code: StockCode) => void
}) {
  const { settings, change } = useChartSettings()
  const sectors = useSectors()
  const set = Effect.runSync(panelSetOf(settings.bubbles.set, selected))
  const shown = { set, window: settings.bubbles.window }
  const view = useMemo(() => panelView(shown.window), [shown.window])
  const cut = useCallback(
    (ranked: ReadonlyArray<BubbleFigures>) =>
      panelBubbles(ranked, set, { selected, watchlist, sectors }),
    [set, selected, watchlist, sectors]
  )
  const frame = useBubbleFrame(flow, view, cut, useMarketPhase(), clockOffset)
  const bubbles = frame._tag === "Shown" ? frame.bubbles : undefined
  const names = useCodeNames(list)
  const pick = (patch: Partial<typeof shown>) =>
    change({ bubbles: { ...settings.bubbles, ...patch } })
  return (
    <section
      aria-label="Bubbles"
      data-codes={bubbles?.map(({ code }) => code).join(" ")}
      className="flex h-[380px] flex-col gap-2"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <h2 className="text-sm font-semibold">Bubbles</h2>
        <span className="text-muted-foreground">
          By value · colour Buy/Sell delta
        </span>
        <Link
          to="/market-bubbles"
          search={Effect.runSync(searchOfView({ window: shown.window }))}
          className="ml-auto font-semibold text-primary hover:underline"
        >
          Open Market Bubbles ↗
        </Link>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <Pressed
          label="Bubbles window"
          options={WINDOW_OPTIONS}
          value={shown.window}
          onPick={(window) => pick({ window })}
        />
        <Pressed
          label="Bubble codes"
          options={[
            { value: "top", label: "Market top 60" },
            { value: "watchlist", label: "Watchlist" },
            {
              value: "sector",
              label: "Sector of selected",
              disabled: INDEX_CODES.includes(selected),
            },
          ]}
          value={set}
          onPick={(next: PanelSet) => pick({ set: next })}
        />
      </div>
      {bubbles === undefined ? (
        <p className="m-auto text-xs text-muted-foreground">
          Bubbles start with the first trade at 09:00.
        </p>
      ) : (
        <BubbleCanvas
          bubbles={bubbles}
          view={view}
          names={names}
          sectors={sectors}
          ringed={selected}
          onPick={onSelect}
          className="min-h-0 flex-1 rounded-md border border-border"
        />
      )}
    </section>
  )
}
