// The Holding composition chart's columns (spec apinrdw/kumora#363, stories
// 29–42): KSEI's holdings of a stock per month, as shares of one origin.
import { Effect } from "effect"

import { KSEI_TYPE_LABELS, KSEI_TYPES, type KseiType } from "@/domain/holdings"
import type { SeriesMonth, TypeHoldings } from "@/server/holdings/stock-page"

import { split } from "./split.ts"
import { percent } from "./stock-page-display.ts"
import type { OriginShown } from "./stock-search.ts"

export type SeriesKey = "local" | "foreign" | KseiType

export interface ChartSeries {
  readonly key: SeriesKey
  readonly label: string
}

export interface ChartColumn {
  // `YYYY-MM`.
  readonly month: string
  // Each series' share of the origin, 0 to 1, in the chart's series order;
  // undefined for a month KSEI has no data for.
  readonly shares: ReadonlyArray<number> | undefined
}

export interface HoldingChart {
  readonly series: ReadonlyArray<ChartSeries>
  readonly columns: ReadonlyArray<ChartColumn>
  // The y-axis' top, 0 to 1.
  readonly axisMax: number
}

const ORIGIN_SERIES: ReadonlyArray<ChartSeries> = [
  { key: "local", label: "Local" },
  { key: "foreign", label: "Foreign" },
]
const TYPE_SERIES: ReadonlyArray<ChartSeries> = KSEI_TYPES.map((type) => ({
  key: type,
  label: KSEI_TYPE_LABELS[type],
}))

const AXIS_STEPS = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1]

const total = (holdings: TypeHoldings) =>
  Effect.succeed(KSEI_TYPES.reduce((sum, type) => sum + holdings[type], 0))

const ofTotal = (values: ReadonlyArray<number>) =>
  Effect.sync(() => {
    const whole = values.reduce((sum, value) => sum + value, 0)
    return values.map((value) => (whole === 0 ? 0 : value / whole))
  })

// One month's shares of the origin, in the chart's series order.
const columnShares = Effect.fnUntraced(function* (
  holdings: NonNullable<SeriesMonth["holdings"]>,
  origin: OriginShown
) {
  return yield* ofTotal(
    origin === "all"
      ? [yield* total(holdings.local), yield* total(holdings.foreign)]
      : KSEI_TYPES.map((type) => holdings[origin][type])
  )
})

// Decision: a share is always of the whole origin, so hiding series never
// inflates one; hiding only zooms the axis to the tallest shown column.
export const holdingChart = Effect.fnUntraced(function* (
  months: ReadonlyArray<SeriesMonth>,
  origin: OriginShown,
  hidden: ReadonlySet<SeriesKey>
) {
  const series = origin === "all" ? ORIGIN_SERIES : TYPE_SERIES
  const columns: Array<ChartColumn> = []
  for (const { month, holdings } of months)
    columns.push({
      month,
      shares:
        holdings === undefined
          ? undefined
          : yield* columnShares(holdings, origin),
    })
  const tallest = Math.max(
    ...columns.map(({ shares = [] }) =>
      shares.reduce(
        (sum, share, index) =>
          series[index] !== undefined && hidden.has(series[index].key)
            ? sum
            : sum + share,
        0
      )
    )
  )
  return {
    series,
    columns,
    axisMax: AXIS_STEPS.find((step) => step >= tallest - 1e-9) ?? 1,
  } satisfies HoldingChart
})

// How a month's shares moved from the calendar month before it: each shown
// series' share in that month, or why there is none to compare with.
export type MonthChange =
  | {
      readonly _tag: "From"
      // `YYYY-MM`.
      readonly month: string
      readonly was: ReadonlyMap<SeriesKey, number>
    }
  | { readonly _tag: "NoData"; readonly month: string }
  | { readonly _tag: "First" }

export const monthChange = Effect.fnUntraced(function* (
  { series, columns }: HoldingChart,
  month: string,
  shown: ReadonlyArray<SeriesKey>
): Effect.fn.Return<MonthChange> {
  const index = columns.findIndex((column) => column.month === month)
  const before = columns[index - 1]
  // As Shareholders composition's note: a month after only gaps is first.
  if (
    before === undefined ||
    columns.slice(0, index).every(({ shares }) => shares === undefined)
  )
    return { _tag: "First" }
  if (before.shares === undefined)
    return { _tag: "NoData", month: before.month }
  const now = columns[index]?.shares ?? []
  const was = new Map<SeriesKey, number>()
  for (const key of shown) {
    const at = series.findIndex((each) => each.key === key)
    const share = before.shares[at] ?? 0
    // Decision: a share that prints the same as last month's has no change,
    // as in Shareholders composition, so no arrow points at an equal figure.
    if ((yield* percent(share)) !== (yield* percent(now[at] ?? 0)))
      was.set(key, share)
  }
  return { _tag: "From", month: before.month, was }
})

// The newest month's scripless split into local and foreign, for the
// summary boxes; `split` is undefined when neither holds a share. The
// series ends on a month KSEI has data for.
export const latestOriginSplit = Effect.fnUntraced(function* (
  months: ReadonlyArray<SeriesMonth>
) {
  const holdings = months.at(-1)?.holdings
  if (holdings === undefined) return undefined
  return {
    periodEnd: holdings.periodEnd,
    split: yield* split(
      yield* total(holdings.local),
      yield* total(holdings.foreign)
    ),
  }
})
