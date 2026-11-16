import { Link } from "@tanstack/react-router"
import type { MarketPhase, StockCode } from "@workspace/relay"
import { INDEX_CODES } from "@workspace/relay"
import { Effect } from "effect"
import { useEffect, useMemo, useState } from "react"

import { useMarketPhase } from "@/components/market-live/market-conditions"
import { useChartSettings } from "@/components/market-live/use-chart-settings"
import type { StockCodeList } from "@/components/market-live/use-stock-code-list"
import {
  PANEL_WINDOWS,
  panelBubbles,
  panelSetOf,
  panelView,
  type PanelSet,
  type PanelWindow,
} from "@/lib/bubble-panel"
import type { SectorLookup } from "@/lib/bubble-sectors"
import {
  bubblesOf,
  windowEnd,
  type BubbleFigures,
  type MarketFlow,
} from "@/lib/bubbles"
import { searchOfView } from "@/lib/market-bubbles-search"

import { BubbleCanvas } from "./bubble-canvas"
import { Pressed } from "./pressed"
import { useSectors } from "./use-sectors"

// Figures recompute every second, as on the page.
const RECOMPUTE_MS = 1000

const WINDOW_OPTIONS = PANEL_WINDOWS.map((window) => ({
  value: window,
  label: window,
}))

// What the panel shows around the selected code.
interface Around {
  readonly selected: StockCode
  readonly watchlist: ReadonlyArray<StockCode>
  readonly sectors: SectorLookup
}

// The set's bubbles over `window` each RECOMPUTE_MS, and at once when either
// changes; none before the day's first trade. The windows end at now on
// Market Live's clock, `clockOffset` ms ahead of the browser's, or at the
// day's last trade out of session.
function usePanelBubbles(
  flow: MarketFlow,
  { set, window }: { set: PanelSet; window: PanelWindow },
  around: Around,
  phase: MarketPhase | undefined,
  clockOffset: number
): ReadonlyArray<BubbleFigures> | undefined {
  const [bubbles, setBubbles] = useState<ReadonlyArray<BubbleFigures>>()
  const { selected, watchlist, sectors } = around
  useEffect(() => {
    if (phase === undefined) return
    const view = panelView(window)
    const recompute = () => {
      const ends = Effect.runSync(
        windowEnd(flow, phase, Date.now() + clockOffset)
      )
      if (ends === undefined) return setBubbles(undefined)
      const ranked = Effect.runSync(bubblesOf(flow, view, ends.end))
      setBubbles(
        Effect.runSync(
          panelBubbles(ranked, set, { selected, watchlist, sectors })
        )
      )
    }
    recompute()
    const timer = setInterval(recompute, RECOMPUTE_MS)
    return () => clearInterval(timer)
  }, [flow, set, window, selected, watchlist, sectors, phase, clockOffset])
  return bubbles
}

// Each listed code's company name, for the tooltip.
const namesOf = (list: StockCodeList) =>
  new Map(
    list._tag === "Ready"
      ? list.codes.map(({ code, name }) => [code, name] as const)
      : []
  )

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
  const around = useMemo(
    () => ({ selected, watchlist, sectors }),
    [selected, watchlist, sectors]
  )
  const bubbles = usePanelBubbles(
    flow,
    shown,
    around,
    useMarketPhase(),
    clockOffset
  )
  const names = useMemo(() => namesOf(list), [list])
  const view = useMemo(() => panelView(shown.window), [shown.window])
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
