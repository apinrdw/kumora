import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { clientRuntime, type StockCode } from "@workspace/client"
import type { ViewerDown, WibDate } from "@workspace/relay"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { useCallback, useEffect, useMemo, useState } from "react"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { DayStrip } from "@/components/market-live/day-strip"
import { LayoutB } from "@/components/market-live/layout-b"
import { FootprintChart } from "@/components/market-live/footprint-chart"
import { LiveChart } from "@/components/market-live/live-chart"
import { LiveTape } from "@/components/market-live/live-tape"
import {
  MarketConditionsBar,
  useRelayGaps,
} from "@/components/market-live/market-conditions"
import { OrderBookPanel } from "@/components/market-live/order-book-panel"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"
import {
  RecordedOrderBook,
  RecordedConditionsBar,
  RecordedTape,
  useRecordedDay,
  useReplayCursor,
} from "@/components/market-live/recorded-day"
import { StockCodePalette } from "@/components/market-live/stock-code-palette"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { SweepLog, useSweeps } from "@/components/market-live/sweep-log"
import { TransportBar } from "@/components/market-live/transport-bar"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { Watchlist } from "@/components/market-live/watchlist"
import {
  DEFAULT_CODE,
  parseMarketLiveSearch,
  type MarketLiveSearch,
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
  const { code: selected = DEFAULT_CODE } = Route.useSearch()
  const navigate = Route.useNavigate()
  const codes = useStockCodeList(day, today)
  // One store per selected code; the Select for it brings a fresh snapshot.
  const candles = useMemo(
    () => Effect.runSync(makeCandleStore(selected)),
    [selected]
  )
  const book = useMemo(
    () => Effect.runSync(makeOrderBookStore(selected)),
    [selected]
  )
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
  const sweeps = useSweeps(selected, day, today)
  const liveGaps = useRelayGaps()
  const apply = useCallback(
    (message: ViewerDown) => {
      candles.apply(message)
      sweeps.apply(message)
      book.apply(message)
      dayStates.apply(message)
    },
    [candles, sweeps, book, dayStates]
  )
  const select = useCallback(
    (code: StockCode) =>
      void navigate({
        search: (previous: MarketLiveSearch) => ({ ...previous, code }),
      }),
    [navigate]
  )
  return (
    <>
      <h1 className="text-2xl font-bold">Market Live</h1>
      <LayoutB
        charts={
          <>
            <LiveChart
              store={candles}
              sweeps={sweeps}
              gaps={cursor === undefined ? liveGaps : gaps}
              dayStates={dayStates}
              conditions={
                cursor === undefined ? (
                  <MarketConditionsBar />
                ) : (
                  <RecordedConditionsBar cursor={cursor} closed={closed} />
                )
              }
              cursor={cursor}
              footer={cursor && <TransportBar cursor={cursor} gaps={gaps} />}
              search={
                <StockCodePicker
                  list={codes}
                  label="Search stock code"
                  shortcut="/"
                  onPick={select}
                  className="ml-auto w-full max-w-xs"
                />
              }
            />
            <FootprintChart store={candles} cursor={cursor} />
          </>
        }
        log={<SweepLog store={sweeps} cursor={cursor} />}
        side={
          <>
            <Watchlist
              codes={watchlist.codes}
              list={codes}
              store={dayStates}
              onAdd={watchlist.add}
              onRemove={watchlist.remove}
              onSelect={select}
            />
            {cursor === undefined ? (
              <>
                <OrderBookPanel store={book} />
                <LiveTape
                  selected={selected}
                  watchlist={watchlist.codes}
                  onSelect={select}
                  onMessage={apply}
                />
              </>
            ) : (
              <>
                <RecordedOrderBook store={book} cursor={cursor} gaps={gaps} />
                <RecordedTape
                  cursor={cursor}
                  gaps={gaps}
                  selected={selected}
                  onSelect={select}
                />
              </>
            )}
          </>
        }
      />
      <StockCodePalette list={codes} onPick={select} />
    </>
  )
}
