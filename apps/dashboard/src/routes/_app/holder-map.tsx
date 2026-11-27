import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"
import { useMemo } from "react"

import { HolderMapPage } from "@/components/holder-map/holder-map"
import { useStockList } from "@/components/stocks/use-stock-list"
import { holderMapView } from "@/lib/holder-map"
import { parseHolderMapSearch, queryOf } from "@/lib/holder-map-search"
import type { HolderMapRead } from "@/server/holdings/holder-map"
import {
  holderMapFn,
  holderMapStocksFn,
} from "@/server/stocks/stocks.functions"

export const Route = createFileRoute("/_app/holder-map")({
  staticData: {
    feature: "stocks",
    crumbs: () => Effect.succeed([{ label: "Holder map" }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseHolderMapSearch(raw)),
  loaderDeps: ({ search }) => ({ query: Effect.runSync(queryOf(search)) }),
  // Declared, so the route's type doesn't depend on itself through
  // loadServerFn.
  loader: ({ deps }): Promise<HolderMapRead> =>
    runLoader(loadServerFn(() => holderMapFn({ data: deps.query }))),
  head: () => ({ meta: [{ title: "Holder map · KUMORA Terminal" }] }),
  component: HolderMapRoute,
})

function HolderMapRoute() {
  const read: HolderMapRead = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const map = useMemo(() => Effect.runSync(holderMapView(read)), [read])
  const list = useStockList(
    search.stock === undefined
      ? "/holder-map"
      : `/holder-map?stock=${encodeURIComponent(search.stock)}`,
    holderMapStocksFn
  )
  return (
    <HolderMapPage
      map={map}
      list={list}
      // A new focus is a new entry, so back returns to the one before.
      onStock={(stock) =>
        void navigate({ search: (previous) => ({ ...previous, stock }) })
      }
    />
  )
}
