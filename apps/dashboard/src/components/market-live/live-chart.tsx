import { ClientOnly } from "@tanstack/react-router"
import { Suspense, lazy, useSyncExternalStore } from "react"

import { plain } from "@/lib/format"

import type { CandleStore } from "./candle-store"

// Decision: Lightweight Charts runs only in the browser, in its own chunk:
// the Worker's server render never imports it, and other pages never load it
// (spec apinrdw/kumora#138, "Chart").
const ChartCanvas = lazy(() => import("./chart-canvas"))

const CHART_HEIGHT = "h-[420px]"

// One figure of the store's candles. It changes at most once a delta, so only
// the header re-renders, never the chart.
function useCandles<A>(
  store: CandleStore,
  read: (candles: ReturnType<CandleStore["candles"]>) => A,
  server: A
) {
  return useSyncExternalStore(
    store.subscribe,
    () => read(store.candles()),
    () => server
  )
}

// The selected code's 1-minute candles with volume, live from the viewer
// socket through `store`.
export function LiveChart({ store }: { store: CandleStore }) {
  const count = useCandles(store, (candles) => candles.length, 0)
  const last = useCandles(store, (candles) => candles.at(-1)?.close, undefined)
  return (
    <section aria-label="Chart" className="flex min-w-0 flex-col gap-2">
      <header className="flex items-baseline gap-3">
        <h2 className="text-lg font-bold">{store.code}</h2>
        <span className="text-[15px] font-semibold tabular-nums">
          {last === undefined ? "—" : plain(last)}
        </span>
      </header>
      {/* The canvas has no text: this says what it draws. */}
      <p className="sr-only">One-minute candles: {count}</p>
      <ClientOnly fallback={<div className={CHART_HEIGHT} />}>
        <Suspense fallback={<div className={CHART_HEIGHT} />}>
          <ChartCanvas store={store} />
        </Suspense>
      </ClientOnly>
      <p className="text-[11px] text-muted-foreground">
        <a
          href="https://www.tradingview.com/"
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          TradingView Lightweight Charts™
        </a>{" "}
        / Copyright (с) 2025 TradingView, Inc.
      </p>
    </section>
  )
}
