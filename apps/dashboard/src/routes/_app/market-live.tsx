import { createFileRoute } from "@tanstack/react-router"

import { LiveTape } from "@/components/market-live/live-tape"

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
      <h1 className="text-2xl font-bold">Market Live</h1>
      <LiveTape />
    </div>
  )
}
