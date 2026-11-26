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

import { useBookAlerts } from "@/components/book-alerts/use-book-alerts"
import { useAllCodes } from "@/components/market-live/all-codes"
import type { BookEventStore } from "@/components/market-live/book-event-store"
import {
  BookEventList,
  useBookEvents,
  useRecentBookEvents,
} from "@/components/market-live/book-events"
import {
  makeBookReadingsStore,
  type BookReadingsStore,
} from "@/components/market-live/book-readings-store"
import { BookReadout } from "@/components/market-live/book-readout"
import {
  makeCandleStore,
  type CandleStore,
} from "@/components/market-live/candle-store"
import { makeChartPair } from "@/components/market-live/chart-pair"
import {
  makeDayStateStore,
  type DayStateStore,
} from "@/components/market-live/day-state-store"
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
import type { HeatmapStore } from "@/components/market-live/heatmap-store"
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
import { useSweepAlertPlayer } from "@/components/market-live/sweep-alert-player"
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
  const bookEvents = useBookEvents(selected, day)
  useRememberedTopN(sweeps)
  return { candles, book, heatmap, sweeps, bookEvents }
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

// The selected code's order book, its levels marked with their recent book
// events: live, or as of the cursor.
function BookPanel({
  store,
  heatmap,
  events,
  cursor,
  gaps,
}: {
  store: OrderBookStore
  heatmap: HeatmapStore
  events: BookEventStore
  cursor: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
}) {
  const marks = useRecentBookEvents(events, cursor)
  return cursor === undefined ? (
    <OrderBookPanel store={store} marks={marks} />
  ) : (
    <RecordedOrderBook
      store={store}
      heatmap={heatmap}
      cursor={cursor}
      gaps={gaps}
      marks={marks}
    />
  )
}

// The running trades: live, whose socket feeds the page through
// `onMessage` and the browser's book event alerts, or as of the cursor. A
// recorded day never alerts.
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
  const tellAlerts = useBookAlerts(cursor === undefined)
  const heard = useCallback(
    (message: ViewerDown) => {
      onMessage(message)
      tellAlerts(message)
    },
    [onMessage, tellAlerts]
  )
  return cursor === undefined ? (
    <LiveTape
      selected={selected}
      watchlist={watchlist}
      onSelect={onSelect}
      onMessage={heard}
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
// code, the panel tab, the sweep log's Big only toggle, and the book
// event a link lands on. Picking a code adds a history entry and leaves the
// event; switching a view replaces it and keeps the scroll.
function useMarketLiveSearch() {
  const { code: selected = DEFAULT_CODE, panel, big, event } = Route.useSearch()
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
    (code: StockCode) => change({ code, event: undefined }, false),
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
    event,
    panel,
    pickPanel,
    log: { bigOnly: big === true, onBigOnly: setBigOnly },
  }
}

// The selected code's charts and, under them, its book readout and book
// events.
function DayCharts({
  code,
  today,
  closed,
  codes,
  onPick,
  event,
  stores,
  flow,
  pair,
  cursor,
  gaps,
  shownGaps,
}: {
  code: StockCode
  today: WibDate
  closed: ClosedMarket["closed"]
  codes: ReturnType<typeof useStockCodeList>
  onPick: (code: StockCode) => void
  event: MarketLiveSearch["event"]
  stores: {
    candles: CandleStore
    book: OrderBookStore
    dayStates: DayStateStore
    readings: BookReadingsStore
    bookEvents: BookEventStore
  }
  flow:
    | {
        heatmap: ReturnType<typeof useHeatmap>
        sweeps: SweepStore
        bookEvents: BookEventStore
      }
    | undefined
  pair: ReturnType<typeof useChartPair>
  cursor: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
  shownGaps: ReadonlyArray<RelayGap>
}) {
  return (
    <>
      <LiveChart
        store={stores.candles}
        heatmap={flow?.heatmap}
        sweeps={flow?.sweeps}
        bookEvents={flow?.bookEvents}
        pair={pair}
        gaps={shownGaps}
        dayStates={stores.dayStates}
        conditions={<ConditionsBar cursor={cursor} closed={closed} />}
        cursor={cursor}
        transport={cursor && <TransportBar cursor={cursor} gaps={gaps} />}
        search={
          <StockCodePicker
            list={codes}
            label="Search stock code"
            shortcut="Ctrl K"
            onPick={onPick}
            className="ml-auto w-full max-w-xs"
          />
        }
      />
      <BookReadout
        code={code}
        today={today}
        readings={stores.readings}
        book={stores.book}
        dayStates={stores.dayStates}
        cursor={cursor}
        gaps={shownGaps}
        events={
          <BookEventList
            store={stores.bookEvents}
            cursor={cursor}
            landOn={event}
          />
        }
      />
    </>
  )
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
  const { selected, select, event, ...view } = useMarketLiveSearch()
  const codes = useStockCodeList(day, today)
  const { candles, book, heatmap, sweeps, bookEvents } = useCodeStores(
    selected,
    day,
    today
  )
  // An index has no aggressor sides: plain candles and total volume only.
  const flow = INDEX_CODES.includes(selected)
    ? undefined
    : { heatmap, sweeps, bookEvents }
  // A recorded day's sweeps can have broker codes: its log gains the broker
  // columns and the width for them.
  const withBrokers = day !== undefined
  const pair = useChartPair(sweeps)
  // The watchlist's Day state store starts empty on the server, and
  // the loader gives it no server snapshot. The watchlist's codes live in the
  // browser's localStorage (use-watchlist.ts), so the server can't know which
  // codes' Day states to load. The server render shows no codes, and the
  // rows fill once the page hydrates and the viewer socket's snapshot arrives.
  // Every code's book readings: a snapshot carries them all, whichever code
  // it selected, so one store serves every code picked. The live page's
  // standout sweeps, every code's, likewise (`useAllCodes`).
  const [{ dayStates, readings }] = useState(() => ({
    dayStates: clientRuntime.runSync(makeDayStateStore()),
    readings: Effect.runSync(makeBookReadingsStore),
  }))
  const { store: standouts, tab: allCodes } = useAllCodes({
    day,
    index: flow === undefined,
    onSelect: select,
  })
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
  const player = useSweepAlertPlayer(day)
  const apply = useCallback(
    (message: ViewerDown) => {
      candles.apply(message)
      sweeps.apply(message)
      book.apply(message)
      heatmap.apply(message)
      dayStates.apply(message)
      readings.apply(message)
      bookEvents.apply(message)
      standouts.apply(message)
      clientRuntime.runFork(player.hear(message))
    },
    [
      candles,
      sweeps,
      book,
      heatmap,
      dayStates,
      readings,
      bookEvents,
      standouts,
      player,
    ]
  )
  return (
    <>
      <h1 className="text-2xl font-bold">Market Live</h1>
      <LayoutB
        code={selected}
        charts={
          <DayCharts
            code={selected}
            today={today}
            closed={closed}
            codes={codes}
            onPick={select}
            event={event}
            stores={{ candles, book, dayStates, readings, bookEvents }}
            flow={flow}
            pair={pair}
            cursor={cursor}
            gaps={gaps}
            shownGaps={shownGaps}
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
        allCodes={allCodes}
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
        book={
          <BookPanel
            store={book}
            heatmap={heatmap}
            events={bookEvents}
            cursor={cursor}
            gaps={gaps}
          />
        }
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
