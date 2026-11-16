// What /stocks/$CODE reads from its URL (spec apinrdw/kumora#363, "URL search
// params"): the Shareholders composition panel's month and origin, the
// Holding composition chart's origin and view, and the Holder size panel's
// month, origin, denominator and view (spec apinrdw/kumora#402), and the
// open tab and the Broker inventory tab's range (spec apinrdw/kumora#437,
// "Dashboard: the stock page"). Each is left out at its default, so a plain
// link stays short.
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { SplitOrigin } from "@/domain/holdings"
import {
  customFrom,
  DEFAULT_RANGE,
  type InventoryWindow,
  RANGE_PRESETS,
} from "@/lib/broker-inventory"

// `YYYY-MM`; absent for the stock's newest month.
const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))

// The origin the panel or the chart shows: one, or all holdings.
export type OriginShown = SplitOrigin | "all"

// The chart's view; absent for bars.
const ChartView = Schema.Literals(["table"])
export type ChartView = typeof ChartView.Type | "bars"

// What Holder size's shares are of; absent for shares outstanding. Scrip
// isn't split by origin, so local and foreign are always of their own
// scripless shares.
const SizeBase = Schema.Literals(["scripless"])
export type SizeBase = typeof SizeBase.Type | "outstanding"

// The open tab; absent for Holdings.
const Tab = Schema.Literals(["brokers"])
export type Tab = typeof Tab.Type | "holdings"

// A range preset; absent for the default, 3M.
const RangeParam = Schema.Literals(
  RANGE_PRESETS.filter((preset) => preset !== DEFAULT_RANGE)
)

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
  readonly tab?: typeof Tab.Type | undefined
  readonly range?: typeof RangeParam.Type | undefined
  // A Custom range, both or neither, which replaces `range`.
  readonly from?: WibDate | undefined
  readonly to?: WibDate | undefined
}

const decodeDate = Schema.decodeUnknownOption(WibDate)

// A Custom range from both dates, From first, at most 2 years long.
const customRange = Effect.fnUntraced(function* (
  rawFrom: unknown,
  rawTo: unknown
) {
  const from = decodeDate(rawFrom)
  const to = decodeDate(rawTo)
  if (Option.isNone(from) || Option.isNone(to) || from.value > to.value)
    return { from: undefined, to: undefined }
  return { from: yield* customFrom(from.value, to.value), to: to.value }
})

/**
 * Keeps the fields that parse and drops anything else, so a stale link still
 * opens the page. A dropped one is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export const parseStockSearch = (
  raw: Record<string, unknown>
): Effect.Effect<StockSearch> =>
  Effect.gen(function* () {
    const custom = yield* customRange(raw.from, raw.to)
    return {
      month: Option.getOrUndefined(
        Schema.decodeUnknownOption(Month)(raw.month)
      ),
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
      tab: Option.getOrUndefined(Schema.decodeUnknownOption(Tab)(raw.tab)),
      range:
        custom.to === undefined
          ? Option.getOrUndefined(
              Schema.decodeUnknownOption(RangeParam)(raw.range)
            )
          : undefined,
      ...custom,
    }
  })

// The range the Broker inventory tab reads.
export const inventoryWindow = (search: StockSearch) =>
  Effect.succeed<InventoryWindow>(
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : { range: search.range ?? DEFAULT_RANGE }
  )

// The search params that name `window`, the others cleared.
export const windowSearch = (window: InventoryWindow) =>
  Effect.succeed<StockSearch>(
    "range" in window
      ? {
          range: window.range === DEFAULT_RANGE ? undefined : window.range,
          from: undefined,
          to: undefined,
        }
      : { range: undefined, from: window.from, to: window.to }
  )

// What the Stock picker carries to the next stock: the tab and the range.
// The holdings panels' months are the stock's own.
export const pickerSearch = (search: StockSearch) =>
  Effect.succeed<StockSearch>({
    tab: search.tab,
    range: search.range,
    from: search.from,
    to: search.to,
  })
