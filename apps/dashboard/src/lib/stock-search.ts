// What /stocks/$CODE reads from its URL (spec apinrdw/kumora#363, "URL search
// params"): the Shareholders composition panel's month and origin, the
// Holding composition chart's origin and view, and the Holder size panel's
// month, origin, denominator and view (spec apinrdw/kumora#402). Each is left out
// at its default, so a plain link stays short.
import { Effect, Option, Schema } from "effect"

import { SplitOrigin } from "@/domain/holdings"

// `YYYY-MM`; absent for the stock's newest month.
const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))

// The origin the panel or the chart shows: one, or all holdings.
export type OriginShown = SplitOrigin | "all"

// The chart's view; absent for bars.
const ChartView = Schema.Literals(["table"])
export type ChartView = typeof ChartView.Type | "bars"

// What Holder size's shares are of; absent for shares outstanding.
const SizeBase = Schema.Literals(["scripless"])

export interface StockSearch {
  readonly month?: string | undefined
  // The panel's origin; absent for all scripless.
  readonly panel?: SplitOrigin | undefined
  // The chart's origin; absent for all.
  readonly chart?: SplitOrigin | undefined
  readonly view?: typeof ChartView.Type | undefined
  // Holder size's month, origin (absent for all), denominator and view.
  readonly sizeMonth?: string | undefined
  readonly sizeOrigin?: SplitOrigin | undefined
  readonly sizeBase?: typeof SizeBase.Type | undefined
  readonly sizeView?: typeof ChartView.Type | undefined
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
      Schema.decodeUnknownOption(SplitOrigin)(raw.panel)
    ),
    chart: Option.getOrUndefined(
      Schema.decodeUnknownOption(SplitOrigin)(raw.chart)
    ),
    view: Option.getOrUndefined(
      Schema.decodeUnknownOption(ChartView)(raw.view)
    ),
    sizeMonth: Option.getOrUndefined(
      Schema.decodeUnknownOption(Month)(raw.sizeMonth)
    ),
    sizeOrigin: Option.getOrUndefined(
      Schema.decodeUnknownOption(SplitOrigin)(raw.sizeOrigin)
    ),
    sizeBase: Option.getOrUndefined(
      Schema.decodeUnknownOption(SizeBase)(raw.sizeBase)
    ),
    sizeView: Option.getOrUndefined(
      Schema.decodeUnknownOption(ChartView)(raw.sizeView)
    ),
  }))
