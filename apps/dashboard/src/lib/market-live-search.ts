// What /market-live reads from its URL (spec apinrdw/kumora#138, "Route and
// nav"): the selected stock code, the recorded day, the phone's panel tab
// and the sweep log's Big only toggle, so a reload or a shared link opens
// them; and the book event a link from the order book radar lands on.
import { StockCode } from "@workspace/client"
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

// The panels layout B shows beside the charts, as tabs on a phone.
export const PANELS = ["sweeps", "watchlist", "book", "tape"] as const
const Panel = Schema.Literals(PANELS)
export type Panel = typeof Panel.Type

// Big only, on; off is absent from the URL.
const BigOnly = Schema.Literal(true)

// A book or order flow event's key (lib/book-events.ts eventKey).
const EventKey = Schema.NonEmptyString

export interface MarketLiveSearch {
  readonly code?: StockCode | undefined
  // The recorded day shown; none for the live page.
  readonly day?: WibDate | undefined
  // The phone's panel tab; none for the first one there.
  readonly panel?: Panel | undefined
  readonly big?: true | undefined
  // The book event the readout's list picks and scrolls to once it lands.
  readonly event?: string | undefined
}

// Selected when the URL names none, or one that doesn't parse.
export const DEFAULT_CODE = StockCode.make("BBCA")

/**
 * Keeps the fields that parse and drops anything else, so a stale link
 * still opens the page. A dropped one is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export const parseMarketLiveSearch = (
  raw: Record<string, unknown>
): Effect.Effect<MarketLiveSearch> =>
  Effect.sync(() => {
    const code = Schema.decodeUnknownOption(StockCode)(raw.code)
    const day = Schema.decodeUnknownOption(WibDate)(raw.day)
    const panel = Schema.decodeUnknownOption(Panel)(raw.panel)
    const big = Schema.decodeUnknownOption(BigOnly)(raw.big)
    const event = Schema.decodeUnknownOption(EventKey)(raw.event)
    return {
      code: Option.getOrUndefined(code),
      day: Option.getOrUndefined(day),
      panel: Option.getOrUndefined(panel),
      big: Option.getOrUndefined(big),
      event: Option.getOrUndefined(event),
    }
  })
