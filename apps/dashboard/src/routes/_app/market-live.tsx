import { createFileRoute } from "@tanstack/react-router"
import type { StockCode } from "@workspace/client"
import type { ViewerDown } from "@workspace/relay"
import { useCallback, useMemo, useState } from "react"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { LiveChart } from "@/components/market-live/live-chart"
import { LiveTape } from "@/components/market-live/live-tape"
import { StockCodePalette } from "@/components/market-live/stock-code-palette"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { Watchlist } from "@/components/market-live/watchlist"
import {
  DEFAULT_CODE,
  parseMarketLiveSearch,
  type MarketLiveSearch,
} from "@/lib/market-live-search"

export const Route = createFileRoute("/_app/market-live")({
  staticData: {
    feature: "market-live",
    crumbs: () => [{ label: "Market Live" }],
  },
  validateSearch: parseMarketLiveSearch,
  head: () => ({ meta: [{ title: "Market Live · KUMORA Terminal" }] }),
  component: MarketLivePage,
})

function MarketLivePage() {
  const { code: selected = DEFAULT_CODE } = Route.useSearch()
  const navigate = Route.useNavigate()
  const codes = useStockCodeList()
  // One store per selected code; the Select for it brings a fresh snapshot.
  const candles = useMemo(() => makeCandleStore(selected), [selected])
  const [dayStates] = useState(makeDayStateStore)
  const watchlist = useWatchlist()
  const onMessage = useCallback(
    (message: ViewerDown) => {
      candles.apply(message)
      dayStates.apply(message)
    },
    [candles, dayStates]
  )
  const select = useCallback(
    (code: StockCode) =>
      void navigate({
        search: (previous: MarketLiveSearch) => ({ ...previous, code }),
      }),
    [navigate]
  )
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Market Live</h1>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <LiveChart
          store={candles}
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
          <LiveTape
            selected={selected}
            watchlist={watchlist.codes}
            onSelect={select}
            onMessage={onMessage}
          />
        </div>
      </div>
      <StockCodePalette list={codes} onPick={select} />
    </div>
  )
}
