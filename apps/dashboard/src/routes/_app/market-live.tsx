import { createFileRoute, useRouter } from "@tanstack/react-router"
import type { StockCode } from "@workspace/client"
import type { ViewerDown, WibDate } from "@workspace/relay"
import { useCallback, useEffect, useMemo, useState } from "react"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { DayStrip } from "@/components/market-live/day-strip"
import { LiveChart } from "@/components/market-live/live-chart"
import { LiveTape } from "@/components/market-live/live-tape"
import {
  MarketStatusBar,
  useRelayGaps,
} from "@/components/market-live/market-status"
import { OrderBookPanel } from "@/components/market-live/order-book-panel"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"
import {
  RecordedOrderBook,
  RecordedStatusBar,
  RecordedTape,
  useRecordedDay,
  useReplayCursor,
} from "@/components/market-live/recorded-day"
import { StockCodePalette } from "@/components/market-live/stock-code-palette"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
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
    crumbs: () => [{ label: "Market Live" }],
  },
  validateSearch: parseMarketLiveSearch,
  loader: () => closedMarketFn(),
  // Looked at again when it may change (below), not on each code picked.
  staleTime: 60_000,
  head: () => ({ meta: [{ title: "Market Live · KUMORA Terminal" }] }),
  component: MarketLivePage,
})

function MarketLivePage() {
  const { day } = Route.useSearch()
  const { closed, changesIn } = Route.useLoaderData()
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
      <DayStrip shown={day} />
      {/* Fresh stores and sockets for each day shown. */}
      <MarketLiveDay
        key={shown ?? "live"}
        day={shown}
        closed={day === undefined ? closed : undefined}
      />
    </div>
  )
}

function MarketLiveDay({
  day,
  closed,
}: {
  day: WibDate | undefined
  closed: ClosedMarket["closed"]
}) {
  const { code: selected = DEFAULT_CODE } = Route.useSearch()
  const navigate = Route.useNavigate()
  const codes = useStockCodeList(day)
  // One store per selected code; the Select for it brings a fresh snapshot.
  const candles = useMemo(() => makeCandleStore(selected), [selected])
  const book = useMemo(() => makeOrderBookStore(selected), [selected])
  const [dayStates] = useState(makeDayStateStore)
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
  const apply = useCallback(
    (message: ViewerDown) => {
      candles.apply(message)
      book.apply(message)
      dayStates.apply(message)
    },
    [candles, book, dayStates]
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <LiveChart
          store={candles}
          gaps={cursor === undefined ? liveGaps : gaps}
          dayStates={dayStates}
          status={
            cursor === undefined ? (
              <MarketStatusBar />
            ) : (
              <RecordedStatusBar cursor={cursor} closed={closed} />
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
        <div className="flex min-w-0 flex-col gap-4">
          <Watchlist
            codes={watchlist.codes}
            list={codes}
            store={dayStates}
            onAdd={watchlist.add}
            onRemove={watchlist.remove}
            onSelect={select}
          />
          {cursor === undefined ? (
            <OrderBookPanel store={book} />
          ) : (
            <RecordedOrderBook store={book} cursor={cursor} gaps={gaps} />
          )}
          {cursor === undefined ? (
            <LiveTape
              selected={selected}
              watchlist={watchlist.codes}
              onSelect={select}
              onMessage={apply}
            />
          ) : (
            <RecordedTape
              cursor={cursor}
              gaps={gaps}
              selected={selected}
              onSelect={select}
            />
          )}
        </div>
      </div>
      <StockCodePalette list={codes} onPick={select} />
    </>
  )
}
