// What /stocks/$CODE reads from its URL (spec apinrdw/kumora#363, "URL search
// params"): the Shareholders composition panel's month and origin, the
// Holding composition chart's origin and view, and the Holder size panel's
// month, origin, denominator and view (spec apinrdw/kumora#402), the Major
// holders panel's month (spec apinrdw/kumora#479), and the open tab and the Broker inventory tab's range, measure, investor filter,
// chips and drag selection (spec apinrdw/kumora#437, "Dashboard: the stock
// page"). Each is left out at its default, so a plain
// link stays short.
import { BrokerCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { SplitOrigin } from "@/domain/holdings"
import {
  type Chip,
  ChipGroup,
  customFrom,
  DEFAULT_CHIPS,
  DEFAULT_LENS,
  DEFAULT_RANGE,
  type InventoryWindow,
  isGroup,
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

const decodeGroup = Schema.decodeUnknownOption(ChipGroup)
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
  // Major holders' month.
  readonly holdersMonth?: string | undefined
  readonly tab?: typeof Tab.Type | undefined
  readonly range?: typeof RangeParam.Type | undefined
  // A Custom range, both or neither, which replaces `range`.
  readonly from?: WibDate | undefined
  readonly to?: WibDate | undefined
  readonly measure?: typeof MeasureParam.Type | undefined
  readonly investor?: typeof InvestorParam.Type | undefined
  // The chips, in order: `buy` and `sell` are the groups, a broker code a
  // single broker. Empty for no chips; absent for both groups. The URL
  // holds them comma-separated (lib/search-url.ts).
  readonly brokers?: ReadonlyArray<Chip> | undefined
  // The drag selection's first and last days, both or neither. The pinned
  // hover day is never in the URL.
  readonly selFrom?: WibDate | undefined
  readonly selTo?: WibDate | undefined
}

const decodeDate = Schema.decodeUnknownOption(WibDate)

// A Custom range from both dates, From first, at most 2 years long.
const customRange = Effect.fnUntraced(function* (
  rawFrom: unknown,
  rawTo: unknown
) {
  const pair = yield* datePair(rawFrom, rawTo)
  if (pair === undefined) return { from: undefined, to: undefined }
  return { from: yield* customFrom(pair.from, pair.to), to: pair.to }
})

// Both dates, From first; else neither.
const datePair = (rawFrom: unknown, rawTo: unknown) =>
  Effect.sync(() => {
    const from = decodeDate(rawFrom)
    const to = decodeDate(rawTo)
    return Option.isNone(from) || Option.isNone(to) || from.value > to.value
      ? undefined
      : { from: from.value, to: to.value }
  })

// The `brokers` param that names `chips`.
export const chipsSearch = (chips: ReadonlyArray<Chip>) =>
  Effect.sync((): StockSearch => ({
    brokers: chips.join(",") === DEFAULT_CHIPS.join(",") ? undefined : chips,
  }))

// The chips a `brokers` list's entries name, in order, unknown entries and
// repeats dropped.
const chipsIn = (entries: ReadonlyArray<unknown>) =>
  Effect.sync(() => {
    const chips: Array<Chip> = []
    for (const entry of entries) {
      const chip = Option.orElse(decodeGroup(entry), () => decodeBroker(entry))
      if (Option.isSome(chip) && !chips.includes(chip.value))
        chips.push(chip.value)
    }
    return chips
  })

// A raw `brokers` as the chips it names: comma-separated as the URL holds
// it, or a list, as a navigation's search object holds it; dropped whole
// when none of a non-empty list parses.
const parseChips = Effect.fnUntraced(function* (raw: unknown) {
  const entries =
    typeof raw === "string" ? (raw === "" ? [] : raw.split(",")) : raw
  if (!Array.isArray(entries)) return undefined
  if (entries.length === 0) return []
  const chips = yield* chipsIn(entries)
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
    const selection = yield* datePair(raw.selFrom, raw.selTo)
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
      holdersMonth: Option.getOrUndefined(
        Schema.decodeUnknownOption(Month)(raw.holdersMonth)
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
      selFrom: selection?.from,
      selTo: selection?.to,
    }
  })

// The range the Broker inventory tab reads.
export const inventoryWindow = (search: StockSearch) =>
  Effect.succeed<InventoryWindow>(
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : { range: search.range ?? DEFAULT_RANGE }
  )

// The search params that name `window`, the others cleared, and the
// selection with them: it was of the old range.
export const windowSearch = (window: InventoryWindow) =>
  Effect.succeed<StockSearch>({
    ...("range" in window
      ? {
          range: window.range === DEFAULT_RANGE ? undefined : window.range,
          from: undefined,
          to: undefined,
        }
      : { range: undefined, from: window.from, to: window.to }),
    selFrom: undefined,
    selTo: undefined,
  })

// The drag selection as the first and last of `days`, the read's axis, it
// covers; none when it reaches outside them or covers no day.
export const selectionOf = (
  search: StockSearch,
  days: ReadonlyArray<WibDate>
) =>
  Effect.sync((): readonly [number, number] | undefined => {
    const { selFrom, selTo } = search
    const start = days[0]
    const end = days.at(-1)
    if (
      selFrom === undefined ||
      selTo === undefined ||
      start === undefined ||
      end === undefined ||
      selFrom < start ||
      selTo > end
    )
      return undefined
    const first = days.findIndex((day) => day >= selFrom)
    // The days are in order, so those up to `selTo` come first.
    const last = days.filter((day) => day <= selTo).length - 1
    return first === -1 || first > last ? undefined : [first, last]
  })

// What the Broker inventory tab's figures count.
export const lensOf = (search: StockSearch) =>
  Effect.succeed<Lens>({
    measure: search.measure ?? DEFAULT_LENS.measure,
    investor: search.investor ?? DEFAULT_LENS.investor,
  })

// The search params that name `lens`.
export const lensSearch = ({ measure, investor }: Lens) =>
  Effect.succeed<StockSearch>({
    measure: measure === DEFAULT_LENS.measure ? undefined : measure,
    investor: investor === DEFAULT_LENS.investor ? undefined : investor,
  })

// The chips the tab plots, in order.
export const chipsOf = (search: StockSearch) =>
  Effect.succeed(search.brokers ?? DEFAULT_CHIPS)

// What the Stock picker carries to the next stock: the tab, the range, the
// measure, the filter and the group chips. Single brokers, the selection
// and the holdings panels' months are the stock's own.
export const pickerSearch = Effect.fnUntraced(function* (search: StockSearch) {
  const groups = (yield* chipsOf(search)).filter(isGroup)
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
