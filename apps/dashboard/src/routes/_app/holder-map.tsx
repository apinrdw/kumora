import { createFileRoute, redirect, useLocation } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"
import { useMemo, useState } from "react"

import { HolderMapPage } from "@/components/holder-map/holder-map"
import { useMapFocusList } from "@/components/holder-map/use-focus-list"
import { holderMapView } from "@/lib/holder-map"
import {
  parseHolderMapSearch,
  queryOf,
  refocused,
  resolvedHolder,
} from "@/lib/holder-map-search"
import type { HolderMapRead } from "@/server/holdings/holder-map-schema"
import { holderMapFn } from "@/server/stocks/stocks.functions"

export const Route = createFileRoute("/_app/holder-map")({
  staticData: {
    feature: "stocks",
    crumbs: () => Effect.succeed([{ label: "Holder map" }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseHolderMapSearch(raw)),
  loaderDeps: ({ search }) => ({ query: Effect.runSync(queryOf(search)) }),
  // The return type is declared, so the route's type doesn't depend on
  // itself through loadServerFn.
  //
  // A holder focus the read took under another key opens under that key,
  // in place of this entry.
  //
  // Decision: the Holder map matches holders across stocks and reports by
  // holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
  loader: ({ deps }): Promise<HolderMapRead> =>
    runLoader(loadServerFn(() => holderMapFn({ data: deps.query }))).then(
      (read) => {
        const holder = Effect.runSync(resolvedHolder(deps.query, read))
        if (holder !== undefined)
          throw redirect({
            to: "/holder-map",
            search: (previous) => ({ ...previous, holder }),
            replace: true,
          })
        return read
      }
    ),
  head: () => ({ meta: [{ title: "Holder map · KUMORA Terminal" }] }),
  component: HolderMapRoute,
})

function HolderMapRoute() {
  const read: HolderMapRead = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // The page the search's sign-in returns to: the one it opened on, so a
  // refocus doesn't load the list again.
  const [opened] = useState(
    useLocation({ select: (location) => location.href })
  )
  const map = useMemo(() => Effect.runSync(holderMapView(read)), [read])
  const list = useMapFocusList(opened, read, search.day)
  return (
    <HolderMapPage
      map={map}
      list={list}
      // A new focus is a new entry, so back returns to the one before; it
      // clears the focus before it and keeps the day.
      onRefocus={(refocus) =>
        void navigate({
          search: (previous) => Effect.runSync(refocused(previous, refocus)),
        })
      }
      // A new day is a new entry too, and keeps the focus.
      onDay={(day) =>
        void navigate({ search: (previous) => ({ ...previous, day }) })
      }
      // A filter, so a new entry too; it hides the map's Off list nodes
      // and its Off list rows.
      showOffList={search.offList !== "hide"}
      onShowOffList={(shown) =>
        void navigate({
          search: (previous) => ({
            ...previous,
            offList: shown ? undefined : "hide",
          }),
        })
      }
    />
  )
}
