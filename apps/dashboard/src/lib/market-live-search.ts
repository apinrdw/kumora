// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code, the recorded day and the watchlist's sort,
// so a reload or a shared link opens them.
import { StockCode } from "@workspace/client"
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

// The watchlist's sortable columns: the code, then its Day state's figures.
const WatchlistSortKey = Schema.Literals([
  "code",
  "last",
  "change",
  "value",
  "volume",
  "frequency",
])
export type WatchlistSortKey = typeof WatchlistSortKey.Type

const SortDirection = Schema.Literals(["asc", "desc"])
export type SortDirection = typeof SortDirection.Type

export interface MarketLiveSearch {
  readonly code?: StockCode | undefined
  // The recorded day shown; none for the live page.
  readonly day?: WibDate | undefined
  // The watchlist's sort; none keeps the order the codes were added in.
  readonly sort?: WatchlistSortKey | undefined
  readonly dir?: SortDirection | undefined
}

// Selected when the URL names none, or one that doesn't parse.
export const DEFAULT_CODE = StockCode.make("BBCA")

/**
 * Keeps a code, a day and a sort that parse and drops anything else, so a
 * stale link still opens the page. A dropped one is set `undefined`: the
 * router lays the validated search over the raw one, which would keep it.
 */
export const parseMarketLiveSearch = (
  raw: Record<string, unknown>
): Effect.Effect<MarketLiveSearch> =>
  Effect.sync(() => {
    const code = Schema.decodeUnknownOption(StockCode)(raw.code)
    const day = Schema.decodeUnknownOption(WibDate)(raw.day)
    const sort = Schema.decodeUnknownOption(WatchlistSortKey)(raw.sort)
    const dir = Schema.decodeUnknownOption(SortDirection)(raw.dir)
    return {
      code: Option.getOrUndefined(code),
      day: Option.getOrUndefined(day),
      sort: Option.getOrUndefined(sort),
      dir: Option.getOrUndefined(dir),
    }
  })
