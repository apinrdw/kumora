// Broker inventory math (spec apinrdw/kumora#437, "Dashboard: broker
// inventory read and math"): everything the Broker inventory tab shows,
// summed in the browser from one range read, with no refetch.
import {
  type BrokerCode,
  type InvestorType,
  SHARES_PER_LOT,
  WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"

// The range presets, in the order the tab offers them; 3M is the default.
export const RANGE_PRESETS = ["2W", "1M", "3M", "6M", "YTD", "1Y"] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]
export const DEFAULT_RANGE = "3M" satisfies RangePreset

// The days a read covers: a preset ending on the newest built day, or a
// Custom From/To.
export type InventoryWindow =
  | { readonly range: RangePreset }
  | { readonly from: WibDate; readonly to: WibDate }

// `day` moved by `parts`, back for negative ones. A month end past the
// shorter month clamps to its last day.
export const shiftDay = (
  day: WibDate,
  parts: Partial<DateTime.DateTime.PartsForMath>
) =>
  Effect.succeed(
    WibDate.make(
      DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(day), parts))
    )
  )

// The day after the date `back` (negative parts) before `to`: the first day
// of a span of that length ending on `to`.
const spanStart = Effect.fnUntraced(function* (
  to: WibDate,
  back: Partial<DateTime.DateTime.PartsForMath>
) {
  return yield* shiftDay(yield* shiftDay(to, back), { days: 1 })
})

// The first day of `preset` when it ends on `to`.
export const rangeStart = Effect.fnUntraced(function* (
  preset: RangePreset,
  to: WibDate
) {
  switch (preset) {
    case "2W":
      return yield* spanStart(to, { days: -14 })
    case "1M":
      return yield* spanStart(to, { months: -1 })
    case "3M":
      return yield* spanStart(to, { months: -3 })
    case "6M":
      return yield* spanStart(to, { months: -6 })
    case "YTD":
      return WibDate.make(`${to.slice(0, 4)}-01-01`)
    case "1Y":
      return yield* spanStart(to, { years: -1 })
  }
})

// Decision: a Custom range is at most 2 years, so the read stays about
// 80 K rows for a liquid code; a From further back is moved up to 2 years
// before To. See spec apinrdw/kumora#437, "Range".
export const customFrom = Effect.fnUntraced(function* (
  from: WibDate,
  to: WibDate
) {
  const earliest = yield* spanStart(to, { years: -2 })
  return from < earliest ? earliest : from
})

// What a figure counts: net lots or net value, over every side or only the
// foreign or domestic ones.
export type Measure = "lots" | "value"
export type Investor = "all" | "foreign" | "domestic"
export interface Lens {
  readonly measure: Measure
  readonly investor: Investor
}
// Net lots over every side.
export const DEFAULT_LENS = {
  measure: "lots",
  investor: "all",
} as const satisfies Lens

// The investor type a foreign or domestic filter keeps.
const INVESTOR_TYPE = {
  foreign: "F",
  domestic: "D",
} as const satisfies Record<Exclude<Investor, "all">, InvestorType>

// A plotted-brokers chip: the Top 5 net buy or Top 5 net sell group, or
// one broker. The chart opens on both groups.
export const ChipGroup = Schema.Literals(["buy", "sell"])
export type ChipGroup = typeof ChipGroup.Type
export type Chip = ChipGroup | BrokerCode
export const isGroup: (chip: Chip) => chip is ChipGroup = Schema.is(ChipGroup)
export const DEFAULT_CHIPS: ReadonlyArray<Chip> = ["buy", "sell"]

// One broker's buys and sells over the range, and its net under the lens.
// An average is undefined for a side it never traded.
export interface SummaryRow {
  readonly broker: BrokerCode
  // Whose sides these are: the type the filter keeps, or under All the one
  // behind most of the broker's lots.
  readonly investorType: InvestorType
  readonly buyLots: number
  readonly buyValue: number
  readonly avgBuy: number | undefined
  readonly sellLots: number
  readonly sellValue: number
  readonly avgSell: number | undefined
  readonly net: number
}

// What the Broker summary's footer counts: its brokers, the lots they
// traded, the range's trades counted, and its incomplete days, which the
// sums skip.
export interface SummaryFooter {
  readonly brokers: number
  readonly lots: number
  readonly trades: number
  readonly incomplete: number
}

// The brokers each default group chip plots.
interface TopBrokers {
  readonly buy: ReadonlyArray<BrokerCode>
  readonly sell: ReadonlyArray<BrokerCode>
}

const TOP = 5

// What the lens makes of each totals row, indexed alike: whether it is a
// side the lens counts, and its net.
const rowsUnder = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens
) {
  const { investorType, buyLots, buyValue, sellLots, sellValue } = read.totals
  const length = investorType.length
  const counts: Array<boolean> = Array.from({ length })
  const net: Array<number> = Array.from({ length })
  for (let row = 0; row < length; row++) {
    counts[row] =
      lens.investor === "all" ||
      investorType[row] === INVESTOR_TYPE[lens.investor]
    net[row] =
      lens.measure === "lots"
        ? (buyLots[row] ?? 0) - (sellLots[row] ?? 0)
        : (buyValue[row] ?? 0) - (sellValue[row] ?? 0)
  }
  return { counts, net }
})

// The hover-day panel: one axis day's close, then per plotted broker its
// running net, that day's net, and its averages from the start of the
// range through that day. A gap has no close.
export interface HoverDay {
  readonly day: WibDate
  readonly close: number | undefined
  readonly rows: ReadonlyArray<{
    readonly broker: BrokerCode
    readonly net: number
    readonly dayNet: number
    readonly avgBuy: number | undefined
    readonly avgSell: number | undefined
  }>
}

// The drag selection's panel: its first and last days, how many days it
// covers and the price change over them in %, then per plotted broker its
// figures over them, by net, highest first, and their Total.
export interface SelectionSummary {
  readonly from: WibDate
  readonly to: WibDate
  readonly days: number
  readonly change: number | undefined
  readonly rows: ReadonlyArray<SpanFigures & { readonly broker: BrokerCode }>
  readonly total: SpanFigures
}

// Weighted by lots: value ÷ (lots × 100); undefined for no lots.
const average = (value: number, lots: number) =>
  Effect.succeed(lots === 0 ? undefined : value / (lots * SHARES_PER_LOT))

// One broker's sums over the range under the lens.
interface BrokerSums {
  buyLots: number
  buyValue: number
  sellLots: number
  sellValue: number
  net: number
  // Its foreign sides' lots, buys and sells.
  foreignLots: number
}

// Each broker's sums under the lens, keyed by its index into `brokers`.
const sumsByBroker = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens
) {
  const { totals } = read
  const rows = yield* rowsUnder(read, lens)
  const sums = new Map<number, BrokerSums>()
  for (let row = 0; row < totals.day.length; row++) {
    if (!rows.counts[row]) continue
    const broker = totals.broker[row] ?? 0
    const sum = sums.get(broker) ?? {
      buyLots: 0,
      buyValue: 0,
      sellLots: 0,
      sellValue: 0,
      net: 0,
      foreignLots: 0,
    }
    const lots = (totals.buyLots[row] ?? 0) + (totals.sellLots[row] ?? 0)
    sum.buyLots += totals.buyLots[row] ?? 0
    sum.buyValue += totals.buyValue[row] ?? 0
    sum.sellLots += totals.sellLots[row] ?? 0
    sum.sellValue += totals.sellValue[row] ?? 0
    sum.net += rows.net[row] ?? 0
    sum.foreignLots += totals.investorType[row] === "F" ? lots : 0
    sums.set(broker, sum)
  }
  return sums
})

// Whose sides a broker's are: the type the filter keeps, or under All the
// one behind most of its lots.
const sidesType = (
  lens: Lens,
  { foreignLots, buyLots, sellLots }: BrokerSums
) =>
  Effect.succeed<InvestorType>(
    lens.investor !== "all"
      ? INVESTOR_TYPE[lens.investor]
      : foreignLots * 2 > buyLots + sellLots
        ? "F"
        : "D"
  )

// Every broker that traded the code in the range, by net, highest first;
// ties in code order.
export const brokerSummary = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens
) {
  const sums = yield* sumsByBroker(read, lens)
  const summary: Array<SummaryRow> = []
  for (const [broker, sum] of [...sums].sort(
    ([a, x], [b, y]) => y.net - x.net || a - b
  ))
    summary.push({
      broker: read.brokers[broker] as BrokerCode,
      investorType: yield* sidesType(lens, sum),
      buyLots: sum.buyLots,
      buyValue: sum.buyValue,
      sellLots: sum.sellLots,
      sellValue: sum.sellValue,
      net: sum.net,
      avgBuy: yield* average(sum.buyValue, sum.buyLots),
      avgSell: yield* average(sum.sellValue, sum.sellLots),
    })
  return summary
})

// Decision: lots traded counts each lot once under All, as the day's
// volume does: every lot has a buy side and a sell side, so each side is
// half a lot. Under a filter, a trade with one side of that type counts
// half. See spec apinrdw/kumora#437, "Broker summary".
//
// The Broker summary's footer for `summary`, from `read`.
export const summaryFooter = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  summary: ReadonlyArray<SummaryRow>
) {
  let sides = 0
  for (const { buyLots, sellLots } of summary) sides += buyLots + sellLots
  let trades = 0
  for (const count of read.candles.trades) trades += count
  return {
    brokers: summary.length,
    lots: sides / 2,
    trades,
    incomplete: read.built.filter((built) => !built).length,
  } satisfies SummaryFooter
})

// Top 5 net buy and Top 5 net sell: the five highest positive nets and the
// five lowest negative ones, each biggest first. A side with fewer has fewer.
export const topBrokers = Effect.fnUntraced(function* (
  summary: ReadonlyArray<SummaryRow>
) {
  return {
    buy: summary
      .filter(({ net }) => net > 0)
      .slice(0, TOP)
      .map(({ broker }) => broker),
    sell: summary
      .filter(({ net }) => net < 0)
      .reverse()
      .slice(0, TOP)
      .map(({ broker }) => broker),
  } satisfies TopBrokers
})

// One plotted line's broker, the chip that plots it and its rank in that
// chip (0 for a single broker).
interface PlottedBroker {
  readonly broker: BrokerCode
  readonly chip: Chip
  readonly rank: number
}

// The brokers `chips` plot, in chip order: a group's in its rank order. A
// broker two chips name is plotted once, by the first.
export const plottedBrokers = Effect.fnUntraced(function* (
  chips: ReadonlyArray<Chip>,
  top: TopBrokers
) {
  const plotted: Array<PlottedBroker> = []
  for (const chip of chips) {
    const brokers = isGroup(chip) ? top[chip] : [chip]
    brokers.forEach((broker, rank) => {
      if (!plotted.some((line) => line.broker === broker))
        plotted.push({ broker, chip, rank })
    })
  }
  return plotted
})

// A broker's sides under the lens, summed over some days.
interface Sides {
  readonly net: number
  readonly buyLots: number
  readonly buyValue: number
  readonly sellLots: number
  readonly sellValue: number
}

// One broker's sides summed from the start of the range through each axis
// day: `net` is its broker inventory, the line the chart plots.
type ToDate = { readonly [Side in keyof Sides]: ReadonlyArray<number> }

// Sides summed over a span of days, with the averages they make.
interface SpanFigures extends Sides {
  readonly avgBuy: number | undefined
  readonly avgSell: number | undefined
}

// The sides a totals row carries as they are; `net` is the lens's.
const ROW_SIDES = ["buyLots", "buyValue", "sellLots", "sellValue"] as const

type Columns = { readonly [Side in keyof Sides]: Array<number> }

const zeroColumns = (length: number) =>
  Effect.sync((): Columns => ({
    net: Array.from({ length }, () => 0),
    buyLots: Array.from({ length }, () => 0),
    buyValue: Array.from({ length }, () => 0),
    sellLots: Array.from({ length }, () => 0),
    sellValue: Array.from({ length }, () => 0),
  }))

const runningSum = (column: ReadonlyArray<number>) =>
  Effect.sync(() => {
    let sum = 0
    return column.map((value) => (sum += value))
  })

// Each of `brokers`' sums to date, in their order. A gap or a day it didn't
// trade adds nothing, so the sums carry across it.
export const brokersToDate = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens,
  brokers: ReadonlyArray<BrokerCode>
) {
  const length = read.days.length
  const daily = new Map<number, Columns>()
  for (const broker of brokers)
    daily.set(read.brokers.indexOf(broker), yield* zeroColumns(length))
  const { totals } = read
  const rows = yield* rowsUnder(read, lens)
  for (let row = 0; row < totals.day.length; row++) {
    const sums = daily.get(totals.broker[row] ?? -1)
    if (sums === undefined || !rows.counts[row]) continue
    const day = totals.day[row] ?? 0
    sums.net[day] = (sums.net[day] ?? 0) + (rows.net[row] ?? 0)
    for (const side of ROW_SIDES)
      sums[side][day] = (sums[side][day] ?? 0) + (totals[side][row] ?? 0)
  }
  const toDate = new Map<BrokerCode, ToDate>()
  for (const broker of brokers) {
    const sums =
      daily.get(read.brokers.indexOf(broker)) ?? (yield* zeroColumns(length))
    toDate.set(broker, {
      net: yield* runningSum(sums.net),
      buyLots: yield* runningSum(sums.buyLots),
      buyValue: yield* runningSum(sums.buyValue),
      sellLots: yield* runningSum(sums.sellLots),
      sellValue: yield* runningSum(sums.sellValue),
    })
  }
  return toDate
})

// What a broker's to-date sums add up to over the days `first` to `last`.
const spanFigures = Effect.fnUntraced(function* (
  toDate: ToDate,
  first: number,
  last: number
) {
  const over = (side: keyof Sides) =>
    (toDate[side][last] ?? 0) - (first > 0 ? (toDate[side][first - 1] ?? 0) : 0)
  const buyLots = over("buyLots")
  const buyValue = over("buyValue")
  const sellLots = over("sellLots")
  const sellValue = over("sellValue")
  return {
    net: over("net"),
    buyLots,
    buyValue,
    sellLots,
    sellValue,
    avgBuy: yield* average(buyValue, buyLots),
    avgSell: yield* average(sellValue, sellLots),
  } satisfies SpanFigures
})

// The close of axis day `day`; undefined for a gap, which has no candle.
const closeOn = (read: BrokerInventoryRead, day: number) =>
  Effect.sync(() => {
    const k = read.candles.day.indexOf(day)
    return k === -1 ? undefined : read.candles.close[k]
  })

// The hover-day panel for axis day `day`, a row per broker of `toDate`.
export const hoverDay = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  toDate: ReadonlyMap<BrokerCode, ToDate>,
  day: number
) {
  const rows = []
  for (const [broker, sums] of toDate) {
    const through = yield* spanFigures(sums, 0, day)
    const today = yield* spanFigures(sums, day, day)
    rows.push({
      broker,
      net: through.net,
      dayNet: today.net,
      avgBuy: through.avgBuy,
      avgSell: through.avgSell,
    })
  }
  return {
    day: read.days[day] as WibDate,
    close: yield* closeOn(read, day),
    rows,
  } satisfies HoverDay
})

// The price change over axis days `first` to `last`, in %: from the first
// candle's open to the last one's close, so a one-day selection shows that
// day's move. Undefined with no candle in the span.
const priceChange = (read: BrokerInventoryRead, first: number, last: number) =>
  Effect.sync(() => {
    const { candles } = read
    const inSpan = candles.day.flatMap((day, k) =>
      day >= first && day <= last ? [k] : []
    )
    const open = candles.open[inSpan[0] ?? -1]
    const close = candles.close[inSpan.at(-1) ?? -1]
    return open === undefined || close === undefined || open === 0
      ? undefined
      : ((close - open) / open) * 100
  })

// The drag selection's panel over axis days `span`, a row per broker of
// `toDate`.
export const selectionSummary = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  toDate: ReadonlyMap<BrokerCode, ToDate>,
  span: readonly [first: number, last: number]
) {
  const [first, last] = span
  const rows: Array<SpanFigures & { readonly broker: BrokerCode }> = []
  for (const [broker, sums] of toDate)
    rows.push({ broker, ...(yield* spanFigures(sums, first, last)) })
  rows.sort((a, b) => b.net - a.net)
  let total: Sides = {
    net: 0,
    buyLots: 0,
    buyValue: 0,
    sellLots: 0,
    sellValue: 0,
  }
  for (const row of rows)
    total = {
      net: total.net + row.net,
      buyLots: total.buyLots + row.buyLots,
      buyValue: total.buyValue + row.buyValue,
      sellLots: total.sellLots + row.sellLots,
      sellValue: total.sellValue + row.sellValue,
    }
  return {
    from: read.days[first] as WibDate,
    to: read.days[last] as WibDate,
    days: last - first + 1,
    change: yield* priceChange(read, first, last),
    rows,
    total: {
      ...total,
      avgBuy: yield* average(total.buyValue, total.buyLots),
      avgSell: yield* average(total.sellValue, total.sellLots),
    },
  } satisfies SelectionSummary
})
