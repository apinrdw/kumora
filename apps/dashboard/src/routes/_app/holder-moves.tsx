import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"
import { useCallback, useMemo } from "react"

import { HolderMovesPage } from "@/components/holder-moves/holder-moves"
import { holderMovesView } from "@/lib/holder-moves"
import {
  filterOf,
  type HolderMovesSearch,
  kindOf,
  moveSearch,
  parseHolderMovesSearch,
  periodOf,
  periodSearch,
} from "@/lib/holder-moves-search"
import type { HolderMovesRead } from "@/server/holdings/holder-moves"
import { holderMovesFn } from "@/server/stocks/stocks.functions"

export const Route = createFileRoute("/_app/holder-moves")({
  staticData: {
    feature: "stocks",
    crumbs: () => Effect.succeed([{ label: "Holder moves" }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseHolderMovesSearch(raw)),
  // The filter and the search narrow the rows already read, and the other
  // kind's period waits in the URL for the toggle.
  loaderDeps: ({ search }) => ({
    kind: Effect.runSync(kindOf(search)),
    period: Effect.runSync(periodOf(search)),
  }),
  // Declared, so the route's type doesn't depend on itself through
  // loadServerFn.
  loader: ({ deps }): Promise<HolderMovesRead> =>
    runLoader(
      loadServerFn(() =>
        holderMovesFn({ data: { kind: deps.kind, period: deps.period } })
      )
    ),
  head: () => ({ meta: [{ title: "Holder moves · KUMORA Terminal" }] }),
  component: HolderMovesRoute,
})

function HolderMovesRoute() {
  const read: HolderMovesRead = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const moves = useMemo(() => Effect.runSync(holderMovesView(read)), [read])
  // Each control changes its own search param, at its default left out.
  const setSearch = useCallback(
    (change: HolderMovesSearch) =>
      void navigate({
        search: (previous: HolderMovesSearch) => ({ ...previous, ...change }),
        replace: true,
        resetScroll: false,
      }),
    [navigate]
  )
  return (
    <HolderMovesPage
      kind={read.kind}
      moves={moves}
      filter={Effect.runSync(filterOf(search))}
      search={search.q ?? ""}
      onFilter={(next) => setSearch({ move: Effect.runSync(moveSearch(next)) })}
      onSearch={(next) => setSearch({ q: next === "" ? undefined : next })}
      onPeriod={(period) =>
        setSearch(Effect.runSync(periodSearch(read.kind, period, read.periods)))
      }
      onKind={(kind) =>
        setSearch({ kind: kind === "daily" ? undefined : kind })
      }
    />
  )
}
