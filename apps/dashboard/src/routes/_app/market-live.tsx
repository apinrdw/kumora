import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { clientRuntime, type StockCode } from "@workspace/client"
import {
  INDEX_CODES,
  type RelayGap,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { useCallback, useEffect, useMemo, useState } from "react"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { makeChartPair } from "@/components/market-live/chart-pair"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { DayStrip } from "@/components/market-live/day-strip"
import { LayoutB } from "@/components/market-live/layout-b"
import { LiveChart } from "@/components/market-live/live-chart"
import { LiveTape } from "@/components/market-live/live-tape"
import {
  MarketConditionsBar,
  useRelayGaps,
} from "@/components/market-live/market-conditions"
import { OrderBookPanel } from "@/components/market-live/order-book-panel"
import {
  makeOrderBookStore,
  type OrderBookStore,
} from "@/components/market-live/order-book-store"
import { useHeatmap } from "@/components/market-live/use-heatmap"
import {
  RecordedOrderBook,
  RecordedConditionsBar,
  RecordedTape,
  useRecordedDay,
  useReplayCursor,
} from "@/components/market-live/recorded-day"
import type { ReplayCursor } from "@/components/market-live/replay-cursor"
import { StockCodePalette } from "@/components/market-live/stock-code-palette"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { soundOn } from "@/components/market-live/sound-toggle"
import { makeSweepAlertPlayer } from "@/components/market-live/sweep-alert-player"
import { sweepAlertSound } from "@/components/market-live/sweep-alert-sound"
import { SweepLog, useSweeps } from "@/components/market-live/sweep-log"
import type { SweepStore } from "@/components/market-live/sweep-store"
import { TransportBar } from "@/components/market-live/transport-bar"
import { useRememberedTopN } from "@/components/market-live/use-chart-settings"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { Watchlist } from "@/components/market-live/watchlist"
import {
  DEFAULT_CODE,
  parseMarketLiveSearch,
  type MarketLiveSearch,
  type Panel,
} from "@/lib/market-live-search"
import type { ClosedMarket } from "@/server/market-live/closed-market"
import { closedMarketFn } from "@/server/market-live/closed-market.functions"

export const Route = createFileRoute("/_app/market-live")({
  staticData: {
    feature: "market-live",
    crumbs: () => Effect.succeed([{ label: "Market Live" }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseMarketLiveSearch(raw)),
  loader: () => runLoader(loadServerFn(() => closedMarketFn())),
  // Looked at again when it may change (below), not on each code picked.
  staleTime: 60_000,
  head: () => ({ meta: [{ title: "Market Live · KUMORA Terminal" }] }),
  component: MarketLivePage,
})

function MarketLivePage() {
  const { day } = Route.useSearch()
  const { closed, today, changesIn } = Route.useLoaderData()
  const router = useRouter()
  // Asked again when the answer may change: 08:40, the 17:00 seal, midnight.
  useEffect(() => {
    const timer = setTimeout(() => void router.invalidate(), changesIn + 1000)
    return () => clearTimeout(timer)
  }, [router, changesIn])
  // The URL's recorded day; else, while the market is shut, the latest
  // trading day at its close; else the live page.
  const shown = day ?? closed?.day
  return (
    <div className="flex flex-col gap-4">
      <DayStrip shown={day} closedDay={closed?.day} />
      {/* Fresh stores and sockets for each day shown. */}
      <MarketLiveDay
        key={shown ?? "live"}
        day={shown}
        today={today}
        closed={day === undefined ? closed : undefined}
      />
    </div>
  )
}

// One store per selected code; the Select for it brings a fresh snapshot.
function useCodeStores(
  selected: StockCode,
  day: WibDate | undefined,
  today: WibDate
) {
  const candles = useMemo(
    () => Effect.runSync(makeCandleStore(selected)),
    [selected]
  )
  const book = useMemo(
    () => Effect.runSync(makeOrderBookStore(selected)),
    [selected]
  )
  const heatmap = useHeatmap(selected, day, today)
  const sweeps = useSweeps(selected, day, today)
  useRememberedTopN(sweeps)
  return { candles, book, heatmap, sweeps }
}

// The candle chart and the footprint chart, moving together; each code's
// charts attach afresh. A sweep picked in the log or on the candle chart moves
// the footprint chart to its minute.
function useChartPair(sweeps: SweepStore) {
  const [pair] = useState(() => Effect.runSync(makeChartPair()))
  useEffect(
    () =>
      sweeps.subscribe((change) => {
        if (change._tag === "Selected") pair.jumpTo(change.minute)
      }),
    [sweeps, pair]
  )
  return pair
}

// The feed pills and market phase: live, or the recorded day's at the cursor.
function ConditionsBar({
  cursor,
  closed,
}: {
  cursor: ReplayCursor | undefined
  closed: ClosedMarket["closed"]
}) {
  return cursor === undefined ? (
    <MarketConditionsBar />
  ) : (
    <RecordedConditionsBar cursor={cursor} closed={closed} />
  )
}

// The selected code's order book: live, or as of the cursor.
function BookPanel({
  store,
  cursor,
  gaps,
}: {
  store: OrderBookStore
  cursor: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
}) {
  return cursor === undefined ? (
    <OrderBookPanel store={store} />
  ) : (
    <RecordedOrderBook store={store} cursor={cursor} gaps={gaps} />
  )
}

// The running trades: live, whose socket feeds the page through
// `onMessage`, or as of the cursor.
function TapePanel({
  selected,
  watchlist,
  cursor,
  gaps,
  onSelect,
  onMessage,
}: {
  selected: StockCode
  watchlist: ReadonlyArray<StockCode>
  cursor: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
  onSelect: (code: StockCode) => void
  onMessage: (message: ViewerDown) => void
}) {
  return cursor === undefined ? (
    <LiveTape
      selected={selected}
      watchlist={watchlist}
      onSelect={onSelect}
      onMessage={onMessage}
    />
  ) : (
    <RecordedTape
      cursor={cursor}
      gaps={gaps}
      selected={selected}
      onSelect={onSelect}
    />
  )
}

// What the page keeps in its URL, so a shared link opens it: the selected
// code, the phone's panel tab and the sweep log's Big only toggle. Picking
// a code adds a history entry; switching a view replaces it and keeps the
// scroll.
function useMarketLiveSearch() {
  const { code: selected = DEFAULT_CODE, panel, big } = Route.useSearch()
  const navigate = Route.useNavigate()
  const change = useCallback(
    (patch: MarketLiveSearch, view: boolean) =>
      void navigate({
        search: (previous: MarketLiveSearch) => ({ ...previous, ...patch }),
        replace: view,
        resetScroll: !view,
      }),
    [navigate]
  )
  const select = useCallback(
    (code: StockCode) => change({ code }, false),
    [change]
  )
  const pickPanel = useCallback(
    (next: Panel) => change({ panel: next }, true),
    [change]
  )
  const setBigOnly = useCallback(
    (on: boolean) => change({ big: on || undefined }, true),
    [change]
  )
  return {
    selected,
    select,
    panel,
    pickPanel,
    log: { bigOnly: big === true, onBigOnly: setBigOnly },
  }
}

function MarketLiveDay({
  day,
  today,
  closed,
}: {
  day: WibDate | undefined
  // The market clock's date: the live page's day.
  today: WibDate
  closed: ClosedMarket["closed"]
}) {
  const { selected, select, ...view } = useMarketLiveSearch()
  const codes = useStockCodeList(day, today)
  const { candles, book, heatmap, sweeps } = useCodeStores(selected, day, today)
  // An index has no aggressor sides: plain candles and total volume only.
  const flow = INDEX_CODES.includes(selected) ? undefined : { heatmap, sweeps }
  // A recorded day's sweeps can have broker codes: its log gains the broker
  // columns and the width for them.
  const withBrokers = day !== undefined
  const pair = useChartPair(sweeps)
  // Decision: the watchlist's Day state store starts empty on the server, and
  // the loader gives it no server snapshot. The watchlist's codes live in the
  // browser's localStorage (use-watchlist.ts), so the server can't know which
  // codes' Day states to load. The server render shows no codes, and the
  // rows fill once the page hydrates and the viewer socket's snapshot arrives.
  const [dayStates] = useState(() => clientRuntime.runSync(makeDayStateStore()))
  const watchlist = useWatchlist()
  const cursor = useReplayCursor(day)
  const gaps = useRecordedDay({
    day,
    cursor,
    selected,
    watchlist: watchlist.codes,
    candles,
    book,
    dayStates,
  })
  const liveGaps = useRelayGaps()
  const shownGaps = cursor === undefined ? liveGaps : gaps
  const [player] = useState(() =>
    Effect.runSync(
      makeSweepAlertPlayer({ sink: sweepAlertSound, day, soundOn })
    )
  )
  const apply = useCallback(
    (message: ViewerDown) => {
      candles.apply(message)
      sweeps.apply(message)
      book.apply(message)
      heatmap.apply(message)
      dayStates.apply(message)
      clientRuntime.runFork(player.hear(message))
    },
    [candles, sweeps, book, heatmap, dayStates, player]
  )
  return (
    <>
      <h1 className="text-2xl font-bold">Market Live</h1>
      <LayoutB
        charts={
          <LiveChart
            store={candles}
            heatmap={flow?.heatmap}
            sweeps={flow?.sweeps}
            pair={pair}
            gaps={shownGaps}
            dayStates={dayStates}
            conditions={<ConditionsBar cursor={cursor} closed={closed} />}
            cursor={cursor}
            transport={cursor && <TransportBar cursor={cursor} gaps={gaps} />}
            search={
              <StockCodePicker
                list={codes}
                label="Search stock code"
                shortcut="Ctrl K"
                onPick={select}
                className="ml-auto w-full max-w-xs"
              />
            }
          />
        }
        log={
          flow && (
            <SweepLog
              store={flow.sweeps}
              cursor={cursor}
              withBrokers={withBrokers}
              {...view.log}
            />
          )
        }
        withBrokers={withBrokers}
        panel={view.panel}
        onPanel={view.pickPanel}
        watchlist={
          <Watchlist
            codes={watchlist.codes}
            list={codes}
            store={dayStates}
            onAdd={watchlist.add}
            onRemove={watchlist.remove}
            onSelect={select}
          />
        }
        book={<BookPanel store={book} cursor={cursor} gaps={gaps} />}
        tape={
          <TapePanel
            selected={selected}
            watchlist={watchlist.codes}
            cursor={cursor}
            gaps={gaps}
            onSelect={select}
            onMessage={apply}
          />
        }
      />
      <StockCodePalette list={codes} onPick={select} />
    </>
  )
}
