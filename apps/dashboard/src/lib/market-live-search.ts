// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code and the recorded day, so a reload or a
// shared link opens them.
import { StockCode } from "@workspace/client"
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

export interface MarketLiveSearch {
  readonly code?: StockCode | undefined
  // The recorded day shown; none for the live page.
  readonly day?: WibDate | undefined
}

// Selected when the URL names none, or one that doesn't parse.
export const DEFAULT_CODE = StockCode.make("BBCA")

/**
 * Keeps a code and a day that parse and drops anything else, so a stale link
 * still opens the page. A dropped one is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export const parseMarketLiveSearch = (
  raw: Record<string, unknown>
): Effect.Effect<MarketLiveSearch> =>
  Effect.sync(() => {
    const code = Schema.decodeUnknownOption(StockCode)(raw.code)
    const day = Schema.decodeUnknownOption(WibDate)(raw.day)
    return {
      code: Option.getOrUndefined(code),
      day: Option.getOrUndefined(day),
    }
  })
