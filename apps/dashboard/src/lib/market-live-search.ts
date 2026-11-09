// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code, so a reload or a shared link opens it.
import { StockCode } from "@workspace/client"
import { Option, Schema } from "effect"

// An IDX code as Ajaib lists it: capitals, digits and a dash (`BUMI-W2`).
const CodeParam = StockCode.check(Schema.isPattern(/^[A-Z0-9-]{1,12}$/))

export interface MarketLiveSearch {
  readonly code?: typeof CodeParam.Type
}

// Selected when the URL names none, or one that doesn't parse.
export const DEFAULT_CODE = StockCode.make("BBCA")

/** Keeps a code that parses and drops anything else, so a stale link still opens the page. */
export function parseMarketLiveSearch(
  raw: Record<string, unknown>
): MarketLiveSearch {
  const code = Schema.decodeUnknownOption(CodeParam)(raw.code)
  return Option.isSome(code) ? { code: code.value } : {}
}
