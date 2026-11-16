// The Broker inventory tab's one read (spec apinrdw/kumora#437, "Dashboard:
// broker inventory read and math"): a stock code's built days, candles and
// broker totals over a range of days, in columns, for the browser's math
// (src/lib/broker-inventory.ts) to sum.
import {
  type BrokerCode,
  type InvestorType,
  isTradingDay,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  customFrom,
  type InventoryWindow,
  rangeStart,
  shiftDay,
} from "@/lib/broker-inventory"

import { readBrokerTotals, readBuiltSpan } from "./db.ts"

// Each column is indexed alike: entry k of every array is one row.
export interface CandleColumns {
  // Index into `days`.
  readonly day: ReadonlyArray<number>
  readonly open: ReadonlyArray<number>
  readonly high: ReadonlyArray<number>
  readonly low: ReadonlyArray<number>
  readonly close: ReadonlyArray<number>
  // Lots.
  readonly volume: ReadonlyArray<number>
  readonly value: ReadonlyArray<number>
  // Regular-board trades counted.
  readonly trades: ReadonlyArray<number>
}

// One row per (day, broker, investor type) the code traded through.
export interface TotalColumns {
  // Index into `days`.
  readonly day: ReadonlyArray<number>
  // Index into `brokers`.
  readonly broker: ReadonlyArray<number>
  readonly investorType: ReadonlyArray<InvestorType>
  readonly buyLots: ReadonlyArray<number>
  readonly buyValue: ReadonlyArray<number>
  readonly sellLots: ReadonlyArray<number>
  readonly sellValue: ReadonlyArray<number>
}

export interface BrokerInventoryRead {
  // The range asked for, clamped: `to` is the newest built day at or before
  // the asked end. With no built day yet, both are the asked ones.
  readonly from: WibDate
  readonly to: WibDate
  // The first built day there is, for the picker; none before any build.
  readonly earliest: WibDate | undefined
  // Today, when it is a trading day not built yet.
  readonly pending: WibDate | undefined
  // The chart's day axis: every trading day and built day from `from` (or
  // `earliest`, if later) to `to`, in order.
  readonly days: ReadonlyArray<WibDate>
  // Per day: built, or a gap the sums carry across.
  readonly built: ReadonlyArray<boolean>
  readonly candles: CandleColumns
  // The brokers `totals` names, in code order.
  readonly brokers: ReadonlyArray<BrokerCode>
  readonly totals: TotalColumns
}

// A day the axis shows when it isn't built: a trading day. A year the
// schedule doesn't have yet counts its weekdays.
const tradingDay = (day: WibDate) =>
  isTradingDay(day).pipe(
    Effect.catchTag("ScheduleYearMissing", () =>
      Effect.sync(() => {
        const { weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(day))
        return weekDay >= 1 && weekDay <= 5
      })
    )
  )

// Every trading day and built day of first..last, in order. At most 2
// years of days.
const axisDays = Effect.fnUntraced(function* (
  first: WibDate,
  last: WibDate,
  builtDays: ReadonlySet<WibDate>
) {
  const days: Array<WibDate> = []
  for (let day = first; day <= last; day = yield* shiftDay(day, { days: 1 }))
    if (builtDays.has(day) || (yield* tradingDay(day))) days.push(day)
  return days
})

// The range `window` names, clamped: it ends at the newest built day at or
// before its end, or at `today` before any build.
const rangeOf = Effect.fnUntraced(function* (
  window: InventoryWindow,
  newest: WibDate | null,
  today: WibDate
) {
  if ("range" in window) {
    const to = newest ?? today
    return { from: yield* rangeStart(window.range, to), to }
  }
  const to = newest !== null && newest < window.to ? newest : window.to
  return { from: yield* customFrom(window.from, to), to }
})

// Decision: the range read answers for `today` on Market Live's clock, the
// caller's: today is pending while it is a trading day without a built
// day. See spec apinrdw/kumora#437, "Range".
//
// `code`'s broker inventory read over `window`.
export const brokerInventory = Effect.fnUntraced(function* (
  code: StockCode,
  window: InventoryWindow,
  today: WibDate
) {
  const span = yield* readBuiltSpan(today)
  const { from, to } = yield* rangeOf(window, span.newest, today)
  const pending =
    span.newest !== today && (yield* tradingDay(today)) ? today : undefined
  const first =
    span.earliest !== null && span.earliest > from ? span.earliest : from
  const range =
    span.earliest === null || first > to
      ? { builtDays: [], candles: [], totals: [] }
      : yield* readBrokerTotals(code, first, to)
  const built = new Set(range.builtDays.map(({ day }) => day))
  const days = span.earliest === null ? [] : yield* axisDays(first, to, built)
  const dayIndex = new Map(days.map((day, index) => [day, index]))
  const brokers = [...new Set(range.totals.map(({ broker }) => broker))].sort()
  const brokerIndex = new Map(brokers.map((broker, index) => [broker, index]))
  const { candles, totals } = range
  return {
    from,
    to,
    earliest: span.earliest ?? undefined,
    pending,
    days,
    built: days.map((day) => built.has(day)),
    candles: {
      day: candles.map(({ day }) => dayIndex.get(day) ?? 0),
      open: candles.map(({ open }) => open),
      high: candles.map(({ high }) => high),
      low: candles.map(({ low }) => low),
      close: candles.map(({ close }) => close),
      volume: candles.map(({ volume }) => volume),
      value: candles.map(({ value }) => value),
      trades: candles.map(({ trades }) => trades),
    },
    brokers,
    totals: {
      day: totals.map(({ day }) => dayIndex.get(day) ?? 0),
      broker: totals.map(({ broker }) => brokerIndex.get(broker) ?? 0),
      investorType: totals.map(({ investorType }) => investorType),
      buyLots: totals.map(({ buyLots }) => buyLots),
      buyValue: totals.map(({ buyValue }) => buyValue),
      sellLots: totals.map(({ sellLots }) => sellLots),
      sellValue: totals.map(({ sellValue }) => sellValue),
    },
  } satisfies BrokerInventoryRead
})
