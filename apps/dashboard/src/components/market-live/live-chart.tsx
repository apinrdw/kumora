import { ClientOnly } from "@tanstack/react-router"
import { Suspense, lazy, useCallback, useSyncExternalStore } from "react"
import type { ReactNode } from "react"

import type { RelayGap, StockCode } from "@workspace/relay"
import { Effect, DateTime } from "effect"

import { KStatusPill } from "@/components/k/status-pill"
import { direction, pct, price, shares, signed } from "@/lib/format"
import { lastCloseAt } from "@/lib/recorded-day"

import type { CandleStore } from "./candle-store"
import type { ChartPair } from "./chart-pair"
import { useDayState, type DayStateStore } from "./day-state-store"
import { FootprintChart } from "./footprint-chart"
import type { BookEventStore } from "./book-event-store"
import type { HeatmapStore } from "./heatmap-store"
import { useAuctionIndicative, useMergedStale } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"
import { TopNControl } from "./sweep-log"
import type { SweepStore } from "./sweep-store"

// Decision: Lightweight Charts runs only in the browser, in its own chunk:
// the Worker's server render never imports it, and other pages never load it
// (spec apinrdw/kumora#138, "Chart").
const ChartCanvas = lazy(() => import("./chart-canvas"))

const CHART_HEIGHT = "h-[420px] lg:h-auto lg:min-h-[420px] lg:flex-1"

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
      Effect.runSync(
        lastCloseAt(
          store.candles(),
          cursor === undefined
            ? undefined
            : DateTime.makeUnsafe(cursor.state().at)
        )
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
// code's last price and change from the previous close, from its Day state
// (no change while it has no previous close, as an index's frames carry
// none), or its last candle's close before it has one; during the auctions,
// its indicative price and volume.
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
        {last === undefined ? "—" : Effect.runSync(price(last))}
      </span>
      {state !== undefined &&
        (state.change === undefined ? (
          <span
            aria-label="Change"
            className="text-[13px] text-muted-foreground"
          >
            —
          </span>
        ) : (
          <span
            aria-label="Change"
            className={`text-[13px] tabular-nums ${CHANGE_TONE[Effect.runSync(direction(state.change.amount))]}`}
          >
            {Effect.runSync(
              signed(
                state.change.amount,
                Number.isInteger(state.change.amount) ? 0 : 2
              )
            )}{" "}
            {Effect.runSync(pct(state.change.percent))}
          </span>
        ))}
      {indicative !== undefined && (
        <span
          aria-label="Indicative price"
          className="text-[13px] tabular-nums"
        >
          Indicative {Effect.runSync(price(indicative.price))} ·{" "}
          {Effect.runSync(shares(indicative.volume))}
        </span>
      )}
    </>
  )
}

// The selected code's chart column: its header, then `transport` on a
// recorded day, then the footprint chart (only with `sweeps`: an index has
// none), then the candle chart: the 1-minute candles with volume, live from the
// viewer socket through `store`, with the sweep bubbles and the book heatmap.
// `search` sits in the header, to choose the code, and `conditions` with it:
// the feed pills and the market phase. On a recorded day, the candles after
// `cursor` are greyed and a clicked candle moves it. The candle chart moves
// The heatmap's book event marks, named under the chart when it has them.
function MarksLegend({ shown }: { shown: boolean }) {
  if (!shown) return null
  return (
    <p className="text-[11px] text-muted-foreground">
      Book event marks: ◆ absorbed, eaten or reloaded · ■ wall appeared, pulled
      or moved · green on the bid, red on the offer
    </p>
  )
}

// with the footprint chart through `pair`.
export function LiveChart({
  store,
  heatmap,
  sweeps,
  bookEvents,
  pair,
  gaps,
  dayStates,
  conditions,
  search,
  cursor,
  transport,
}: {
  store: CandleStore
  // The selected code's book heatmap, behind the candles.
  heatmap?: HeatmapStore
  // The selected code's sweeps, as bubbles under a top-N filter.
  sweeps?: SweepStore | undefined
  // The selected code's book events, marked on the heatmap.
  bookEvents?: BookEventStore | undefined
  pair: ChartPair
  // The relay gaps to shade as not recorded.
  gaps: ReadonlyArray<RelayGap>
  dayStates: DayStateStore
  conditions?: ReactNode
  search?: ReactNode
  cursor?: ReplayCursor | undefined
  transport?: ReactNode
}) {
  const count = useCandles(store, (candles) => candles.length, 0)
  const last = useLastClose(store, cursor)
  // Both feeds down: the candles stay, dimmed.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Chart"
      data-stale={stale || undefined}
      className="flex min-w-0 flex-col gap-4 lg:flex-[1_1_auto]"
    >
      <div className="flex flex-col gap-2">
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
        {transport}
      </div>
      {sweeps !== undefined && (
        <FootprintChart store={store} pair={pair} gaps={gaps} cursor={cursor} />
      )}
      <section
        aria-label="Candles"
        className="flex min-w-0 flex-col gap-2 lg:flex-[1_1_auto]"
      >
        {sweeps !== undefined && (
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-[15px] font-bold">Candles</h3>
            {/* Under the title on a phone. */}
            <div className="max-lg:basis-full">
              <TopNControl store={sweeps} cursor={cursor} />
            </div>
          </div>
        )}
        {/* The canvas has no text: this says what it draws. */}
        <p className="sr-only">One-minute candles: {count}</p>
        <div
          className={`flex min-h-0 flex-1 flex-col ${stale ? "opacity-50" : ""}`}
        >
          <ClientOnly fallback={<div className={CHART_HEIGHT} />}>
            <Suspense fallback={<div className={CHART_HEIGHT} />}>
              <ChartCanvas
                store={store}
                heatmap={heatmap}
                sweeps={sweeps}
                bookEvents={bookEvents}
                cursor={cursor}
                gaps={gaps}
                pair={pair}
              />
            </Suspense>
          </ClientOnly>
        </div>
        <MarksLegend shown={bookEvents !== undefined} />
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
    </section>
  )
}
