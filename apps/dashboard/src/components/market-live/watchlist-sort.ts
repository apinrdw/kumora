import type { DayStateSnapshot } from "@workspace/client"
import type { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { useMemo, useSyncExternalStore } from "react"

import { sortRows } from "@/components/k/sort"
import type {
  MarketLiveSearch,
  SortDirection,
  WatchlistSortKey,
} from "@/lib/market-live-search"

import type { DayStateStore, HeldDayState } from "./day-state-store"

export interface WatchlistSort {
  readonly key: WatchlistSortKey
  readonly dir: SortDirection
}

// The direction a column sorts in first: codes A to Z, figures largest first.
const firstDirection = (key: WatchlistSortKey): SortDirection =>
  key === "code" ? "asc" : "desc"

// The URL's sort; a column without a direction sorts in its first one.
export const watchlistSortOf = Effect.fnUntraced(function* (
  search: Pick<MarketLiveSearch, "sort" | "dir">
): Effect.fn.Return<WatchlistSort | undefined> {
  if (search.sort === undefined) return undefined
  return { key: search.sort, dir: search.dir ?? firstDirection(search.sort) }
})

// A header click cycles its column: the first direction, the other, then back
// to the order the codes were added in.
export const nextWatchlistSort = Effect.fnUntraced(function* (
  current: WatchlistSort | undefined,
  key: WatchlistSortKey
): Effect.fn.Return<WatchlistSort | undefined> {
  const first = firstDirection(key)
  if (current?.key !== key) return { key, dir: first }
  if (current.dir === first)
    return { key, dir: first === "asc" ? "desc" : "asc" }
  return undefined
})

// The codes in `sort`'s order by their Day state; codes without the figure
// (no Day state yet, or no change) last either way.
export const sortWatchlist = Effect.fnUntraced(function* (
  codes: ReadonlyArray<StockCode>,
  snapshot: DayStateSnapshot<HeldDayState>,
  sort: WatchlistSort
) {
  const rows = codes.map((code) => {
    const state = snapshot.get(code)
    return {
      code,
      last: state?.last,
      change: state?.change?.percent,
      value: state?.value,
      volume: state?.volume,
      frequency: state?.frequency,
    }
  })
  const sorted = yield* sortRows(rows, sort)
  return sorted.map((row) => row.code)
})

const unsubscribed = () => () => {}

// The watchlist's codes in `sort`'s order. Sorted by a Day state figure, the
// table re-sorts on each frame of updates: the table re-renders, and its
// memoized rows skip every code that didn't change.
export function useWatchlistOrder(
  codes: ReadonlyArray<StockCode>,
  store: DayStateStore,
  sort: WatchlistSort | undefined
) {
  const byDayState = sort !== undefined && sort.key !== "code"
  const snapshot = useSyncExternalStore(
    byDayState ? store.subscribe : unsubscribed,
    store.getSnapshot,
    store.getServerSnapshot
  )
  return useMemo(
    () =>
      sort === undefined
        ? codes
        : Effect.runSync(sortWatchlist(codes, snapshot, sort)),
    [codes, snapshot, sort]
  )
}
