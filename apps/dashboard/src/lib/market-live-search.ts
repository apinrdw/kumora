// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code and the recorded day, so a reload or a
// shared link opens them.
import { StockCode } from "@workspace/client"
import { WibDate } from "@workspace/relay"
import { Option, Schema } from "effect"

// An IDX code as Ajaib lists it: capitals, digits and a dash (`BUMI-W2`).
const CodeParam = StockCode.check(Schema.isPattern(/^[A-Z0-9-]{1,12}$/))

export interface MarketLiveSearch {
  readonly code?: typeof CodeParam.Type | undefined
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
export function parseMarketLiveSearch(
  raw: Record<string, unknown>
): MarketLiveSearch {
  const code = Schema.decodeUnknownOption(CodeParam)(raw.code)
  const day = Schema.decodeUnknownOption(WibDate)(raw.day)
  return { code: Option.getOrUndefined(code), day: Option.getOrUndefined(day) }
}
