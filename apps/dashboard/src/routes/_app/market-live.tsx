import { createFileRoute } from "@tanstack/react-router"

import { useState } from "react"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { LiveChart } from "@/components/market-live/live-chart"
import { LiveTape, SELECTED } from "@/components/market-live/live-tape"

export const Route = createFileRoute("/_app/market-live")({
  staticData: {
    feature: "market-live",
    crumbs: () => [{ label: "Market Live" }],
  },
  head: () => ({ meta: [{ title: "Market Live · KUMORA Terminal" }] }),
  component: MarketLivePage,
})

function MarketLivePage() {
  const [candles] = useState(() => makeCandleStore(SELECTED))
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Market Live</h1>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <LiveChart store={candles} />
        <LiveTape onMessage={candles.apply} />
      </div>
    </div>
  )
}
