// What /market-bubbles reads from its URL (spec apinrdw/kumora#427, "The
// page"): the size and colour metrics, the window, Top N and the sector, so a reload or a
// shared link opens the same view. A default stays out of the URL.
import { SectorName } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import {
  BUBBLE_WINDOWS,
  COLOUR_METRICS,
  SIZE_METRICS,
  TOP_NS,
  type BubbleView,
} from "@/lib/bubbles"

const Size = Schema.Literals(SIZE_METRICS)
const Colour = Schema.Literals(COLOUR_METRICS)
const Window = Schema.Literals(BUBBLE_WINDOWS)
const Top = Schema.Literals(TOP_NS)

export type MarketBubblesSearch = {
  readonly [K in keyof BubbleView]?: BubbleView[K] | undefined
}

export const DEFAULT_VIEW: BubbleView = {
  size: "value",
  colour: "delta",
  window: "5m",
  top: 100,
  sector: undefined,
}

// `patch` as search params: each default set `undefined`, which the router
// leaves out of the URL.
export const searchOfView = (patch: MarketBubblesSearch) =>
  Effect.sync(() => {
    const search: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch))
      search[key] =
        value === DEFAULT_VIEW[key as keyof BubbleView] ? undefined : value
    return search as MarketBubblesSearch
  })

const field = <A>(schema: Schema.Codec<A>, raw: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(raw))

/**
 * Keeps the fields that parse and aren't a default, and drops anything else.
 * A dropped one is set `undefined`: the router lays the validated search over
 * the raw one, which would keep it.
 */
export const parseMarketBubblesSearch = (raw: Record<string, unknown>) =>
  searchOfView({
    size: field(Size, raw.size),
    colour: field(Colour, raw.colour),
    window: field(Window, raw.window),
    top: field(Top, raw.top),
    sector: field(SectorName, raw.sector),
  })

// The view the search names, with a default for each field it leaves out.
export const viewOfSearch = (search: MarketBubblesSearch) =>
  Effect.sync((): BubbleView => ({
    size: search.size ?? DEFAULT_VIEW.size,
    colour: search.colour ?? DEFAULT_VIEW.colour,
    window: search.window ?? DEFAULT_VIEW.window,
    top: search.top ?? DEFAULT_VIEW.top,
    sector: search.sector,
  }))
