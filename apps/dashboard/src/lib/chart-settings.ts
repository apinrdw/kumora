// The chart settings a browser remembers (spec apinrdw/kumora#263,
// "Settings"): chart 1's top-N, and chart 2's view mode, imbalance ratio and
// POC and VWAP toggles.
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

export interface ChartSettings {
  readonly topN: number
  readonly mode: FootprintMode
  readonly imbalance: ImbalanceRatio
  readonly poc: boolean
  readonly vwap: boolean
}

export const CHART_SETTINGS_DEFAULT: ChartSettings = {
  topN: TOP_N_DEFAULT,
  mode: "stacked",
  imbalance: 3,
  poc: true,
  vwap: true,
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

// The stored text's settings: each that parses is kept, the rest default.
export const parseChartSettings = Effect.fnUntraced(function* (
  raw: string | null
) {
  const stored = yield* Effect.try((): unknown => JSON.parse(raw ?? "{}")).pipe(
    Effect.orElseSucceed(() => undefined)
  )
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return CHART_SETTINGS_DEFAULT
  const at = (key: keyof ChartSettings): unknown =>
    (stored as Partial<Record<keyof ChartSettings, unknown>>)[key]
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
  } satisfies ChartSettings
})
