import { createFileRoute } from "@tanstack/react-router"
import type { StockCode } from "@workspace/client"
import { useCallback } from "react"

import { LiveTape } from "@/components/market-live/live-tape"
import { StockCodePalette } from "@/components/market-live/stock-code-palette"
import { StockCodePicker } from "@/components/market-live/stock-code-picker"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
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
      <section aria-label="Chart" className="flex flex-col gap-2">
        <header className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{selected}</h2>
          <StockCodePicker
            list={codes}
            label="Search stock code"
            shortcut="/"
            onPick={select}
            className="w-full max-w-xs"
          />
        </header>
      </section>
      <StockCodePalette list={codes} onPick={select} />
      <LiveTape selected={selected} onSelect={select} />
    </div>
  )
}
