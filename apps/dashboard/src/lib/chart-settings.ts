// The chart settings a browser remembers (spec apinrdw/kumora#263,
// "Settings"): the candle chart's top-N, the footprint chart's view mode,
// imbalance ratio and POC and VWAP toggles, and each chart's zoom.
import { Effect, Schema } from "effect"

import { TOP_N_DEFAULT } from "./sweeps"

export const FOOTPRINT_MODES = [
  "stacked",
  "side",
  "profile",
  "candles",
] as const
export type FootprintMode = (typeof FOOTPRINT_MODES)[number]

// Off, then the ratios one side must beat the other by.
export const IMBALANCE_RATIOS = [0, 2, 3, 4] as const
export type ImbalanceRatio = (typeof IMBALANCE_RATIOS)[number]

// A chart's zoom as the viewer's last gesture left it, the same for every
// code. A field not there is the chart's default zoom.
// The zoom level only, never where the chart is: live data opens
// at the latest minute and a recorded day at its cursor.
interface ChartZoom {
  // How many times tighter than its automatic fit the price axis is, about
  // its middle: a factor, not a price range, so it fits codes whose prices
  // differ a hundredfold, and the axis still follows the price.
  readonly priceStretch?: number | undefined
}

interface CandleZoom extends ChartZoom {
  // Pixels a minute. The candle chart keeps it through a resize, showing
  // more or fewer minutes.
  readonly barSpacing?: number | undefined
}

interface FootprintZoom extends ChartZoom {
  // Minutes across the chart. Its window refits to as many through a jump or
  // a resize.
  readonly minutes?: number | undefined
}

export interface ChartZooms {
  readonly candles: CandleZoom
  readonly footprint: FootprintZoom
}

export interface ChartSettings {
  readonly topN: number
  readonly mode: FootprintMode
  readonly imbalance: ImbalanceRatio
  readonly poc: boolean
  readonly vwap: boolean
  readonly zoom: ChartZooms
}

export const CHART_SETTINGS_DEFAULT: ChartSettings = {
  topN: TOP_N_DEFAULT,
  mode: "stacked",
  imbalance: 3,
  poc: true,
  vwap: true,
  zoom: { candles: {}, footprint: {} },
}

// The 1% preset, or the slider's 5% steps.
const TopN = Schema.Int.check(
  Schema.makeFilter(
    (n: number) => n === 1 || (n % 5 === 0 && n >= 5 && n <= 100)
  )
)

// A stored setting if it parses, else its default.
const storedOr = <A>(schema: Schema.Decoder<A>, value: unknown, fallback: A) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.orElseSucceed(() => fallback)
  )

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// `value`'s field `key`, if `value` is an object.
const fieldOf = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

// A stored zoom field if it is a positive number, else the default.
const zoomOr = (value: unknown) => storedOr(Positive, value, undefined)

// The stored text's settings: each that parses is kept, the rest default.
export const parseChartSettings = Effect.fnUntraced(function* (
  raw: string | null
) {
  const stored = yield* Effect.try((): unknown => JSON.parse(raw ?? "{}")).pipe(
    Effect.orElseSucceed(() => undefined)
  )
  if (!isRecord(stored)) return CHART_SETTINGS_DEFAULT
  const at = (key: keyof ChartSettings): unknown => stored[key]
  const zoom = (chart: keyof ChartZooms, key: string) =>
    zoomOr(fieldOf(fieldOf(at("zoom"), chart), key))
  const fallback = CHART_SETTINGS_DEFAULT
  return {
    topN: yield* storedOr(TopN, at("topN"), fallback.topN),
    mode: yield* storedOr(
      Schema.Literals(FOOTPRINT_MODES),
      at("mode"),
      fallback.mode
    ),
    imbalance: yield* storedOr(
      Schema.Literals(IMBALANCE_RATIOS),
      at("imbalance"),
      fallback.imbalance
    ),
    poc: yield* storedOr(Schema.Boolean, at("poc"), fallback.poc),
    vwap: yield* storedOr(Schema.Boolean, at("vwap"), fallback.vwap),
    zoom: {
      candles: {
        barSpacing: yield* zoom("candles", "barSpacing"),
        priceStretch: yield* zoom("candles", "priceStretch"),
      },
      footprint: {
        minutes: yield* zoom("footprint", "minutes"),
        priceStretch: yield* zoom("footprint", "priceStretch"),
      },
    },
  } satisfies ChartSettings
})
