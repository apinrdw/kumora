// Broker inventory math (spec apinrdw/kumora#437, "Dashboard: broker
// inventory read and math"): everything the Broker inventory tab shows,
// summed in the browser from one range read, with no refetch.
import {
  type BrokerCode,
  type InvestorType,
  SHARES_PER_LOT,
  WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

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

// The day after the date `parts` before `to`: the first day of a span of
// that length ending on `to`. A month end past the shorter month clamps to
// its last day.
const spanStart = (
  to: WibDate,
  parts: Partial<DateTime.DateTime.PartsForMath>
) =>
  Effect.succeed(
    WibDate.make(
      DateTime.formatIsoDate(
        DateTime.add(DateTime.subtract(DateTime.makeUnsafe(to), parts), {
          days: 1,
        })
      )
    )
  )

// The first day of `preset` when it ends on `to`.
export const rangeStart = Effect.fnUntraced(function* (
  preset: RangePreset,
  to: WibDate
) {
  switch (preset) {
    case "2W":
      return yield* spanStart(to, { days: 14 })
    case "1M":
      return yield* spanStart(to, { months: 1 })
    case "3M":
      return yield* spanStart(to, { months: 3 })
    case "6M":
      return yield* spanStart(to, { months: 6 })
    case "YTD":
      return WibDate.make(`${to.slice(0, 4)}-01-01`)
    case "1Y":
      return yield* spanStart(to, { years: 1 })
  }
})

// Decision: a Custom range is at most 2 years, so the read stays about
// 80 K rows for a liquid code; a From further back is moved up to 2 years
// before To. See spec apinrdw/kumora#437, "Range".
export const customFrom = Effect.fnUntraced(function* (
  from: WibDate,
  to: WibDate
) {
  const earliest = yield* spanStart(to, { years: 2 })
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

// A plotted-brokers chip: the Top 5 net buy or Top 5 net sell group, or
// one broker. The chart opens on both groups.
export type Chip = "buy" | "sell" | BrokerCode
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
// traded, and the range's incomplete days, which the sums skip.
export interface SummaryFooter {
  readonly brokers: number
  readonly lots: number
  readonly incomplete: number
}

// The brokers each default group chip plots.
interface TopBrokers {
  readonly buy: ReadonlyArray<BrokerCode>
  readonly sell: ReadonlyArray<BrokerCode>
}

const TOP = 5

// What the lens makes of one totals row: whether it is a side the lens
// counts, and its net. Called per row, so they stay plain closures.
const rowsUnder = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens
) {
  const { investorType, buyLots, buyValue, sellLots, sellValue } = read.totals
  const type = lens.investor === "foreign" ? "F" : "D"
  return {
    counts: (row: number) =>
      lens.investor === "all" || investorType[row] === type,
    net: (row: number) =>
      lens.measure === "lots"
        ? (buyLots[row] ?? 0) - (sellLots[row] ?? 0)
        : (buyValue[row] ?? 0) - (sellValue[row] ?? 0),
  }
})

// Every broker that traded the code in the range, by net, highest first;
// ties in code order.
export const brokerSummary = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens
) {
  const { totals } = read
  const rows = yield* rowsUnder(read, lens)
  const sums = new Map<
    number,
    {
      buyLots: number
      buyValue: number
      sellLots: number
      sellValue: number
      net: number
      foreignLots: number
    }
  >()
  for (let row = 0; row < totals.day.length; row++) {
    if (!rows.counts(row)) continue
    const broker = totals.broker[row] ?? 0
    const sum = sums.get(broker) ?? {
      buyLots: 0,
      buyValue: 0,
      sellLots: 0,
      sellValue: 0,
      net: 0,
      foreignLots: 0,
    }
    sum.buyLots += totals.buyLots[row] ?? 0
    sum.buyValue += totals.buyValue[row] ?? 0
    sum.sellLots += totals.sellLots[row] ?? 0
    sum.sellValue += totals.sellValue[row] ?? 0
    sum.net += rows.net(row)
    if (totals.investorType[row] === "F")
      sum.foreignLots +=
        (totals.buyLots[row] ?? 0) + (totals.sellLots[row] ?? 0)
    sums.set(broker, sum)
  }
  return [...sums]
    .sort(([a, x], [b, y]) => y.net - x.net || a - b)
    .map(([broker, { foreignLots, ...sum }]): SummaryRow => ({
      broker: read.brokers[broker] as BrokerCode,
      investorType:
        lens.investor === "foreign"
          ? "F"
          : lens.investor === "domestic"
            ? "D"
            : foreignLots * 2 > sum.buyLots + sum.sellLots
              ? "F"
              : "D",
      ...sum,
      // Weighted by lots: value ÷ (lots × 100).
      avgBuy:
        sum.buyLots === 0
          ? undefined
          : sum.buyValue / (sum.buyLots * SHARES_PER_LOT),
      avgSell:
        sum.sellLots === 0
          ? undefined
          : sum.sellValue / (sum.sellLots * SHARES_PER_LOT),
    }))
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
  return {
    brokers: summary.length,
    lots: sides / 2,
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
    const brokers =
      chip === "buy" ? top.buy : chip === "sell" ? top.sell : [chip]
    brokers.forEach((broker, rank) => {
      if (!plotted.some((line) => line.broker === broker))
        plotted.push({ broker, chip, rank })
    })
  }
  return plotted
})

// Each of `brokers`' broker inventory: its running net from the start of
// the range, one point per axis day. A gap or a day it didn't trade adds
// nothing, so the sum carries across it.
export const runningNets = Effect.fnUntraced(function* (
  read: BrokerInventoryRead,
  lens: Lens,
  brokers: ReadonlyArray<BrokerCode>
) {
  const wanted = new Map(
    brokers.map((broker) => [
      read.brokers.indexOf(broker),
      Array.from({ length: read.days.length }, () => 0),
    ])
  )
  const { totals } = read
  const rows = yield* rowsUnder(read, lens)
  for (let row = 0; row < totals.day.length; row++) {
    const daily = wanted.get(totals.broker[row] ?? -1)
    if (daily === undefined || !rows.counts(row)) continue
    const day = totals.day[row] ?? 0
    daily[day] = (daily[day] ?? 0) + rows.net(row)
  }
  const nets = new Map<BrokerCode, ReadonlyArray<number>>()
  for (const broker of brokers) {
    let sum = 0
    const daily = wanted.get(read.brokers.indexOf(broker))
    nets.set(
      broker,
      read.days.map((_, day) => (sum += daily?.[day] ?? 0))
    )
  }
  return nets
})
