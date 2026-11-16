import { MINUTE_MS } from "@workspace/relay"
import { ClientOnly } from "@tanstack/react-router"
import { Effect } from "effect"
import {
  Suspense,
  lazy,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react"

import {
  FOOTPRINT_MODES,
  IMBALANCE_RATIOS,
  type ChartSettings,
  type FootprintMode,
} from "@/lib/chart-settings"
import { footprintSummary } from "@/lib/footprint"
import { cn } from "@workspace/ui/lib/utils"

import type { RelayGap } from "@workspace/relay"

import type { CandleStore } from "./candle-store"
import type { ChartPair } from "./chart-pair"
import { FootprintHeader, makeHeaderStore } from "./footprint-header"
import { useMergedStale } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"
import { useChartSettings } from "./use-chart-settings"

// Decision: like the candle chart, the footprint chart runs Lightweight Charts
// only in the browser, in its own chunk (live-chart.tsx; spec
// apinrdw/kumora#138, "Chart").
const FootprintCanvas = lazy(() => import("./footprint-canvas"))

const CHART_HEIGHT = "h-[380px] lg:h-auto lg:min-h-[380px] lg:flex-1"

// What the canvas shows, in words: how many footprint minutes there are, and
// the exact Vol, Δ and CVD of the latest one (at or before the cursor on a
// recorded day). It changes at most once a delta or a cursor minute.
function useFootprintSummary(
  store: CandleStore,
  cursor: ReplayCursor | undefined
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const stopStore = store.subscribe(listener)
      const stopCursor = cursor?.subscribe(listener)
      return () => {
        stopStore()
        stopCursor?.()
      }
    },
    [store, cursor]
  )
  return useSyncExternalStore(
    subscribe,
    () =>
      Effect.runSync(
        footprintSummary(
          store.footprints(),
          cursor === undefined
            ? Number.POSITIVE_INFINITY
            : Math.floor(cursor.state().at / MINUTE_MS) * MINUTE_MS
        )
      ),
    () => "Footprint minutes: 0"
  )
}

const MODE_LABEL: Record<FootprintMode, string> = {
  stacked: "Stacked",
  side: "Side by side",
  profile: "Footprint",
  candles: "Candles",
}

// The footprint chart's own settings: its view mode tabs, the imbalance ratio,
// and the POC and VWAP toggles, remembered in this browser.
function FootprintControls({
  settings,
  change,
}: {
  settings: ChartSettings
  change: (patch: Partial<ChartSettings>) => void
}) {
  const toggle = (on: boolean) =>
    cn(
      "rounded-md border border-border px-1.5 py-px",
      on ? "border-primary text-primary" : "hover:bg-elevated"
    )
  return (
    // Under the title on a phone.
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground max-lg:basis-full">
      <div
        role="tablist"
        aria-label="Footprint view"
        className="inline-flex gap-0.5 rounded-md border border-border bg-sidebar p-0.5"
      >
        {FOOTPRINT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={settings.mode === mode}
            onClick={() => change({ mode })}
            className={cn(
              "rounded-sm px-2 py-px",
              settings.mode === mode
                ? "bg-elevated text-foreground"
                : "hover:text-foreground"
            )}
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1">
        Imbalance
        <select
          value={settings.imbalance}
          onChange={(event) => {
            const ratio = IMBALANCE_RATIOS.find(
              (option) => String(option) === event.target.value
            )
            if (ratio !== undefined) change({ imbalance: ratio })
          }}
          className="bg-surface rounded-md border border-border px-1 py-px text-foreground"
        >
          {IMBALANCE_RATIOS.map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio === 0 ? "Off" : `${ratio}×`}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-pressed={settings.poc}
        onClick={() => change({ poc: !settings.poc })}
        className={toggle(settings.poc)}
      >
        POC
      </button>
      <button
        type="button"
        aria-pressed={settings.vwap}
        onClick={() => change({ vwap: !settings.vwap })}
        className={toggle(settings.vwap)}
      >
        VWAP ±σ
      </button>
    </div>
  )
}

// The footprint chart: the selected code's footprint, each minute's lots at
// each price in the view mode picked, with imbalances, POC and the day's VWAP
// bands, its Vol / Δ / CVD footer, and a header reading the hovered minute,
// above the candle chart. It draws the candle chart's minutes, relay `gaps`
// included, and moves with it through `pair`.
export function FootprintChart({
  store,
  pair,
  gaps,
  cursor,
}: {
  store: CandleStore
  pair: ChartPair
  gaps: ReadonlyArray<RelayGap>
  cursor?: ReplayCursor | undefined
}) {
  const summary = useFootprintSummary(store, cursor)
  const { settings, change } = useChartSettings()
  const [header] = useState(() => Effect.runSync(makeHeaderStore))
  // Both feeds down: the cells stay, dimmed.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Footprint"
      data-stale={stale || undefined}
      className="flex min-w-0 flex-col gap-2 lg:flex-[1.25_1_auto]"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-[15px] font-bold">Footprint</h3>
          <FootprintControls settings={settings} change={change} />
        </div>
        <FootprintHeader store={header} />
      </header>
      {/* The canvas has no text: this says what it draws. */}
      <p className="sr-only">{summary}</p>
      <div
        className={`flex min-h-0 flex-1 flex-col ${stale ? "opacity-50" : ""}`}
      >
        <ClientOnly fallback={<div className={CHART_HEIGHT} />}>
          <Suspense fallback={<div className={CHART_HEIGHT} />}>
            <FootprintCanvas
              store={store}
              pair={pair}
              gaps={gaps}
              settings={settings}
              header={header}
              cursor={cursor}
            />
          </Suspense>
        </ClientOnly>
      </div>
    </section>
  )
}
