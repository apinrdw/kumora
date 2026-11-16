// What /market-bubbles reads from its URL (spec apinrdw/kumora#427, "The
// page"): the size and colour metrics, the window, Top N and the sector, so a reload or a
// shared link opens the same view. A default stays out of the URL; a phone's
// default view is PHONE_VIEW.
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

// Below `lg` the map opens on Top 50 (spec apinrdw/kumora#427, "Search
// params").
export const PHONE_VIEW: BubbleView = { ...DEFAULT_VIEW, top: 50 }

// `patch` as search params: each of `defaults` set `undefined`, which the
// router leaves out of the URL.
export const searchOfView = (
  patch: MarketBubblesSearch,
  defaults: BubbleView = DEFAULT_VIEW
) =>
  Effect.sync(() => {
    const search: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch))
      search[key] =
        value === defaults[key as keyof BubbleView] ? undefined : value
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
  Effect.map(
    searchOfView({
      size: field(Size, raw.size),
      colour: field(Colour, raw.colour),
      window: field(Window, raw.window),
      sector: field(SectorName, raw.sector),
    }),
    // Decision: `top` passes at any value. Its default is the device's (Top
    // 50 below `lg`), which the route can't know; the page drops a `top` that
    // is its device's default once it knows the device (useBubbleView), so
    // an absent `top` means the device's default.
    (search): MarketBubblesSearch => ({ ...search, top: field(Top, raw.top) })
  )

// The view the search names, with one of `defaults` for each field it leaves
// out.
export const viewOfSearch = (
  search: MarketBubblesSearch,
  defaults: BubbleView = DEFAULT_VIEW
) =>
  Effect.sync((): BubbleView => ({
    size: search.size ?? defaults.size,
    colour: search.colour ?? defaults.colour,
    window: search.window ?? defaults.window,
    top: search.top ?? defaults.top,
    sector: search.sector,
  }))
