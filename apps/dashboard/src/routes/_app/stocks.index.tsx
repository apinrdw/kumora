import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Effect } from "effect"
import { useEffect } from "react"

import { lastStock } from "@/lib/last-stock"

// Bare /stocks opens the stock this browser last opened, or Market Live's
// default code. Browser storage exists only in the browser, so the redirect
// waits for it there.
export const Route = createFileRoute("/_app/stocks/")({
  staticData: {
    feature: "stocks",
    crumbs: () => Effect.succeed([{ label: "Stocks" }]),
  },
  component: StocksIndex,
})

function StocksIndex() {
  const navigate = useNavigate()
  useEffect(() => {
    void navigate({
      to: "/stocks/$code",
      params: { code: Effect.runSync(lastStock) },
      replace: true,
    })
  }, [navigate])
  return null
}
