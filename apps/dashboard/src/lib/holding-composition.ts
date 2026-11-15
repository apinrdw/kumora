// The Holding composition chart's columns (spec apinrdw/kumora#363, stories
// 29–42): KSEI's holdings of a stock per month, as shares of one origin.
import { KSEI_TYPE_LABELS, KSEI_TYPES, type KseiType } from "@/domain/holdings"
import type { SeriesMonth, TypeHoldings } from "@/server/holdings/stock-page"

import type { ChartOrigin } from "./stock-search.ts"

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
  KSEI_TYPES.reduce((sum, type) => sum + holdings[type], 0)

const ofTotal = (values: ReadonlyArray<number>) => {
  const whole = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => (whole === 0 ? 0 : value / whole))
}

// Decision: a share is always of the whole origin, so hiding series never
// inflates one; hiding only zooms the axis to the tallest shown column.
export const holdingChart = (
  months: ReadonlyArray<SeriesMonth>,
  origin: ChartOrigin,
  hidden: ReadonlySet<string>
): HoldingChart => {
  const series = origin === "all" ? ORIGIN_SERIES : TYPE_SERIES
  const columns = months.map(({ month, holdings }) => ({
    month,
    shares:
      holdings &&
      ofTotal(
        origin === "all"
          ? [total(holdings.local), total(holdings.foreign)]
          : KSEI_TYPES.map((type) => holdings[origin][type])
      ),
  }))
  const tallest = Math.max(
    ...columns.map(({ shares = [] }) =>
      shares.reduce(
        (sum, share, index) =>
          hidden.has(series[index]?.key ?? "") ? sum : sum + share,
        0
      )
    )
  )
  return {
    series,
    columns,
    axisMax: AXIS_STEPS.find((step) => step >= tallest - 1e-9) ?? 1,
  }
}

// The newest month's local share of scripless, for the summary boxes. The
// series ends on a month KSEI has data for.
export const latestOriginSplit = (months: ReadonlyArray<SeriesMonth>) => {
  const holdings = months.at(-1)?.holdings
  if (holdings === undefined) return undefined
  const [local = 0] = ofTotal([total(holdings.local), total(holdings.foreign)])
  return { periodEnd: holdings.periodEnd, local }
}
