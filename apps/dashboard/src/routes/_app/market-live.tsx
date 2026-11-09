import { createFileRoute } from "@tanstack/react-router"

import { LiveTape } from "@/components/market-live/live-tape"
import { MarketStatusBar } from "@/components/market-live/market-status"

export const Route = createFileRoute("/_app/market-live")({
  staticData: {
    feature: "market-live",
    crumbs: () => [{ label: "Market Live" }],
  },
  head: () => ({ meta: [{ title: "Market Live · KUMORA Terminal" }] }),
  component: MarketLivePage,
})

function MarketLivePage() {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold">Market Live</h1>
        <MarketStatusBar />
      </header>
      <LiveTape />
    </div>
  )
}
