// What /stocks/$CODE reads from its URL (spec apinrdw/kumora#363, "URL search
// params"): the Shareholders composition panel's month and origin, and the
// Holding composition chart's origin and view. Each is left out at its
// default, so a plain link stays short.
import { Effect, Option, Schema } from "effect"

// `YYYY-MM`; absent for the stock's newest month.
const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))

// The panel's origin; absent for all scripless.
const PanelOrigin = Schema.Literals(["local", "foreign"])
export type PanelOrigin = typeof PanelOrigin.Type | "all"

// The chart's origin; absent for all.
const ChartOrigin = Schema.Literals(["local", "foreign"])
export type ChartOrigin = typeof ChartOrigin.Type | "all"

// The chart's view; absent for bars.
const ChartView = Schema.Literals(["table"])
export type ChartView = typeof ChartView.Type | "bars"

export interface StockSearch {
  readonly month?: string | undefined
  readonly panel?: typeof PanelOrigin.Type | undefined
  readonly chart?: typeof ChartOrigin.Type | undefined
  readonly view?: typeof ChartView.Type | undefined
}

/**
 * Keeps the fields that parse and drops anything else, so a stale link still
 * opens the page. A dropped one is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export const parseStockSearch = (
  raw: Record<string, unknown>
): Effect.Effect<StockSearch> =>
  Effect.sync(() => ({
    month: Option.getOrUndefined(Schema.decodeUnknownOption(Month)(raw.month)),
    panel: Option.getOrUndefined(
      Schema.decodeUnknownOption(PanelOrigin)(raw.panel)
    ),
    chart: Option.getOrUndefined(
      Schema.decodeUnknownOption(ChartOrigin)(raw.chart)
    ),
    view: Option.getOrUndefined(
      Schema.decodeUnknownOption(ChartView)(raw.view)
    ),
  }))
