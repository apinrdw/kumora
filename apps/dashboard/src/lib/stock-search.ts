// What /stocks/$CODE reads from its URL (spec apinrdw/kumora#363, "URL search
// params"): the Shareholders composition panel's month and origin, the
// Holding composition chart's origin and view, and the Holder size panel's
// month, origin, denominator and view (spec apinrdw/kumora#402), and the
// open tab and the Broker inventory tab's range, measure, investor filter
// and chips (spec apinrdw/kumora#437, "Dashboard: the stock page"). Each is left out at its default, so a plain
// link stays short.
import { BrokerCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { SplitOrigin } from "@/domain/holdings"
import {
  type Chip,
  customFrom,
  DEFAULT_CHIPS,
  DEFAULT_RANGE,
  type InventoryWindow,
  type Lens,
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

// Net value; absent for net lots.
const MeasureParam = Schema.Literals(["value"])

// Foreign or domestic sides only; absent for all.
const InvestorParam = Schema.Literals(["foreign", "domestic"])

const decodeGroup = Schema.decodeUnknownOption(Schema.Literals(["buy", "sell"]))
const decodeBroker = Schema.decodeUnknownOption(BrokerCode)

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
  readonly measure?: typeof MeasureParam.Type | undefined
  readonly investor?: typeof InvestorParam.Type | undefined
  // The chips, in order, comma-separated: `buy` and `sell` are the groups,
  // a broker code a single broker. Empty for no chips; absent for both
  // groups.
  readonly brokers?: string | undefined
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

// The `brokers` param that names `chips`.
export const chipsSearch = (chips: ReadonlyArray<Chip>) =>
  Effect.sync((): StockSearch => {
    const brokers = chips.join(",")
    return {
      brokers: brokers === DEFAULT_CHIPS.join(",") ? undefined : brokers,
    }
  })

// The chips a raw `brokers` names, in order, unknown entries and repeats
// dropped; dropped whole when none of a non-empty list parses.
const parseChips = Effect.fnUntraced(function* (raw: unknown) {
  if (typeof raw !== "string") return undefined
  if (raw === "") return ""
  const chips: Array<Chip> = []
  for (const entry of raw.split(",")) {
    const chip = Option.orElse(decodeGroup(entry), () => decodeBroker(entry))
    if (Option.isSome(chip) && !chips.includes(chip.value))
      chips.push(chip.value)
  }
  return chips.length === 0 ? undefined : (yield* chipsSearch(chips)).brokers
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
      measure: Option.getOrUndefined(
        Schema.decodeUnknownOption(MeasureParam)(raw.measure)
      ),
      investor: Option.getOrUndefined(
        Schema.decodeUnknownOption(InvestorParam)(raw.investor)
      ),
      brokers: yield* parseChips(raw.brokers),
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

// What the Broker inventory tab's figures count.
export const lensOf = (search: StockSearch) =>
  Effect.succeed<Lens>({
    measure: search.measure ?? "lots",
    investor: search.investor ?? "all",
  })

// The chips the tab plots, in order.
export const chipsOf = (search: StockSearch) =>
  Effect.succeed<ReadonlyArray<Chip>>(
    search.brokers === undefined
      ? DEFAULT_CHIPS
      : search.brokers === ""
        ? []
        : // Parsed into chips by `parseChips`.
          (search.brokers.split(",") as ReadonlyArray<Chip>)
  )

// What the Stock picker carries to the next stock: the tab, the range, the
// measure, the filter and the group chips. Single brokers and the holdings
// panels' months are the stock's own.
export const pickerSearch = Effect.fnUntraced(function* (search: StockSearch) {
  const groups = (yield* chipsOf(search)).filter(
    (chip) => chip === "buy" || chip === "sell"
  )
  return {
    tab: search.tab,
    range: search.range,
    from: search.from,
    to: search.to,
    measure: search.measure,
    investor: search.investor,
    brokers: (yield* chipsSearch(groups)).brokers,
  } satisfies StockSearch
})
