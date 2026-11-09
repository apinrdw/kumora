import { ClientOnly } from "@tanstack/react-router"
import { Suspense, lazy, useCallback, useSyncExternalStore } from "react"
import type { ReactNode } from "react"

import type { RelayGap, StockCode } from "@workspace/relay"
import { DateTime } from "effect"

import { KStatusPill } from "@/components/k/status-pill"
import { direction, pct, price, shares, signed } from "@/lib/format"
import { lastCloseAt } from "@/lib/recorded-day"

import type { CandleStore } from "./candle-store"
import { useDayState, type DayStateStore } from "./day-state-store"
import { useAuctionIndicative, useMergedStale } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"

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

// The code's last close for the header, read as of the cursor on a recorded
// day. It changes at most once a minute of the cursor, so only the header
// re-renders.
function useLastClose(store: CandleStore, cursor: ReplayCursor | undefined) {
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
      lastCloseAt(
        store.candles(),
        cursor === undefined
          ? undefined
          : DateTime.makeUnsafe(cursor.state().at)
      ),
    () => undefined
  )
}

const CHANGE_TONE = {
  up: "text-up",
  down: "text-down",
  flat: "text-muted-foreground",
} as const

// The header's headline figures (spec apinrdw/kumora#138, "Layout"): the
// code's last price and change from the previous close, from its Day state,
// or its last candle's close before it has one; during the auctions, its
// indicative price and volume.
function ChartHeadline({
  code,
  dayStates,
  lastClose,
}: {
  code: StockCode
  dayStates: DayStateStore
  lastClose: number | undefined
}) {
  const state = useDayState(dayStates, code)
  const indicative = useAuctionIndicative(code)
  const last = state?.last ?? lastClose
  return (
    <>
      <span
        aria-label="Last price"
        className="text-[15px] font-semibold tabular-nums"
      >
        {last === undefined ? "—" : price(last)}
      </span>
      {state !== undefined && (
        <span
          aria-label="Change"
          className={`text-[13px] tabular-nums ${CHANGE_TONE[direction(state.change)]}`}
        >
          {signed(state.change, Number.isInteger(state.change) ? 0 : 2)}{" "}
          {pct(state.changePercent)}
        </span>
      )}
      {indicative !== undefined && (
        <span
          aria-label="Indicative price"
          className="text-[13px] tabular-nums"
        >
          Indicative {price(indicative.price)} · {shares(indicative.volume)}
        </span>
      )}
    </>
  )
}

// The selected code's 1-minute candles with volume, live from the viewer
// socket through `store`. `search` sits in the header, to choose the code,
// and `conditions` with it: the feed pills and the market phase.
// On a recorded day, the candles after `cursor` are greyed and a clicked
// candle moves it; `footer` sits under the chart.
export function LiveChart({
  store,
  gaps,
  dayStates,
  conditions,
  search,
  cursor,
  footer,
}: {
  store: CandleStore
  // The relay gaps to shade as not recorded.
  gaps: ReadonlyArray<RelayGap>
  dayStates: DayStateStore
  conditions?: ReactNode
  search?: ReactNode
  cursor?: ReplayCursor | undefined
  footer?: ReactNode
}) {
  const count = useCandles(store, (candles) => candles.length, 0)
  const last = useLastClose(store, cursor)
  // Both feeds down: the candles stay, dimmed.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Chart"
      data-stale={stale || undefined}
      className="flex min-w-0 flex-col gap-2"
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-bold">{store.code}</h2>
        <ChartHeadline
          code={store.code}
          dayStates={dayStates}
          lastClose={last}
        />
        {stale && <KStatusPill status="stale" />}
        {conditions}
        {search}
      </header>
      {/* The canvas has no text: this says what it draws. */}
      <p className="sr-only">One-minute candles: {count}</p>
      <div className={stale ? "opacity-50" : undefined}>
        <ClientOnly fallback={<div className={CHART_HEIGHT} />}>
          <Suspense fallback={<div className={CHART_HEIGHT} />}>
            <ChartCanvas store={store} cursor={cursor} gaps={gaps} />
          </Suspense>
        </ClientOnly>
      </div>
      {footer}
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
