// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code, so a reload or a shared link opens it.
import { StockCode } from "@workspace/client"
import { Option, Schema } from "effect"

// An IDX code as Ajaib lists it: capitals, digits and a dash (`BUMI-W2`).
const CodeParam = StockCode.check(Schema.isPattern(/^[A-Z0-9-]{1,12}$/))

export interface MarketLiveSearch {
  readonly code?: typeof CodeParam.Type | undefined
}

// Selected when the URL names none, or one that doesn't parse.
export const DEFAULT_CODE = StockCode.make("BBCA")

/**
 * Keeps a code that parses and drops anything else, so a stale link still
 * opens the page. A dropped code is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export function parseMarketLiveSearch(
  raw: Record<string, unknown>
): MarketLiveSearch {
  const code = Schema.decodeUnknownOption(CodeParam)(raw.code)
  return { code: Option.getOrUndefined(code) }
}
