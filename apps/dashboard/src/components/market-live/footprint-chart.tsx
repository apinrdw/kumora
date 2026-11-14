import { ClientOnly } from "@tanstack/react-router"
import { Effect } from "effect"
import { Suspense, lazy, useCallback, useSyncExternalStore } from "react"

import { footprintSummary } from "@/lib/footprint"

import type { RelayGap } from "@workspace/relay"

import type { CandleStore } from "./candle-store"
import type { ChartPair } from "./chart-pair"
import { useMergedStale } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"

// Decision: like chart 1, chart 2 runs Lightweight Charts only in the
// browser, in its own chunk (live-chart.tsx; spec apinrdw/kumora#138,
// "Chart").
const FootprintCanvas = lazy(() => import("./footprint-canvas"))

const CHART_HEIGHT = "h-[380px]"
const MINUTE = 60_000

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
            : Math.floor(cursor.state().at / MINUTE) * MINUTE
        )
      ),
    () => "Footprint minutes: 0"
  )
}

// Chart 2: the selected code's footprint, Stacked `sell × buy` lots at each
// price of each minute, with its Vol / Δ / CVD footer, under chart 1. It
// draws chart 1's minutes, relay `gaps` included, and moves with it through
// `pair`.
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
  // Both feeds down: the cells stay, dimmed.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Footprint"
      data-stale={stale || undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-bold">Footprint</h2>
        <span className="text-[12px] text-muted-foreground">
          Stacked · sell × buy lots
        </span>
      </header>
      {/* The canvas has no text: this says what it draws. */}
      <p className="sr-only">{summary}</p>
      <div className={stale ? "opacity-50" : undefined}>
        <ClientOnly fallback={<div className={CHART_HEIGHT} />}>
          <Suspense fallback={<div className={CHART_HEIGHT} />}>
            <FootprintCanvas
              store={store}
              pair={pair}
              gaps={gaps}
              cursor={cursor}
            />
          </Suspense>
        </ClientOnly>
      </div>
    </section>
  )
}
