// The stock page's Holding composition (scripless) chart (spec
// apinrdw/kumora#363, stories 29–42; prototype variant D): KSEI's holdings
// of the stock per month, as stacked columns or a table, with a legend that
// hides series.
import { cn } from "@workspace/ui/lib/utils"
import { useLayoutEffect, useRef, useState } from "react"

import { KChip } from "@/components/k/chip"
import { kCard, kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import {
  type ChartColumn,
  type ChartSeries,
  type HoldingChart,
  holdingChart,
  latestOriginSplit,
  type SeriesKey,
} from "@/lib/holding-composition"
import type { ChartOrigin, ChartView } from "@/lib/stock-search"
import type { SeriesMonth } from "@/server/holdings/stock-page"

import { monthLabel, percent, TYPE_COLOR } from "./shareholders-composition"

const NO_DATA = "No data"

const SERIES_COLOR: Record<SeriesKey, string> = {
  local: "var(--origin-local)",
  foreign: "var(--origin-foreign)",
  ...TYPE_COLOR,
}

const ORIGINS: ReadonlyArray<{ value: ChartOrigin; label: string }> = [
  { value: "all", label: "All" },
  { value: "local", label: "Local" },
  { value: "foreign", label: "Foreign" },
]

const VIEWS: ReadonlyArray<{ value: ChartView; label: string }> = [
  { value: "bars", label: "Bars" },
  { value: "table", label: "Table" },
]

// The bars' height in px, and a column's width.
const HEIGHT = 240
const COLUMN = "w-9"

// A click waits this long in case it is the first of a double-click.
const DOUBLE_CLICK_MS = 220

const NONE_HIDDEN: ReadonlySet<SeriesKey> = new Set()

const ofWhat = (origin: ChartOrigin) =>
  origin === "all" ? "scripless shares" : `all ${origin} holdings`

/** `2026-10` → `Oct 26` */
const shortMonth = (month: string) =>
  `${monthLabel(month).slice(0, 4)}${month.slice(2, 4)}`

export type HoldingCompositionProps = {
  series: ReadonlyArray<SeriesMonth>
  origin: ChartOrigin
  view: ChartView
  onOrigin: (origin: ChartOrigin) => void
  onView: (view: ChartView) => void
}

export function HoldingComposition({
  series,
  origin,
  view,
  onOrigin,
  onView,
}: HoldingCompositionProps) {
  // Hidden series belong to the origin they were hidden in: another origin
  // shows every series again.
  const [hiding, setHiding] = useState<{
    readonly origin: ChartOrigin
    readonly hidden: ReadonlySet<SeriesKey>
  }>({ origin, hidden: NONE_HIDDEN })
  const hidden = hiding.origin === origin ? hiding.hidden : NONE_HIDDEN
  const setHidden = (next: ReadonlySet<SeriesKey>) =>
    setHiding({ origin, hidden: next })
  const chart = holdingChart(series, origin, hidden)
  const shown = chart.series.flatMap((each, index) =>
    hidden.has(each.key) ? [] : [{ ...each, index }]
  )
  return (
    <section
      aria-labelledby="holding-composition"
      className={cn(kCard, "flex flex-col gap-3")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="holding-composition" className="text-[15px] font-semibold">
          Holding composition (scripless)
        </h2>
        <Picks label="View" options={VIEWS} value={view} onPick={onView} />
      </div>
      <Picks
        label="Chart origin"
        options={ORIGINS}
        value={origin}
        onPick={onOrigin}
      />
      <OriginSummary series={series} />
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_200px]">
        {view === "bars" ? (
          <Bars chart={chart} shown={shown} origin={origin} />
        ) : (
          <Table chart={chart} shown={shown} />
        )}
        <Legend
          series={chart.series}
          hidden={hidden}
          origin={origin}
          onHidden={setHidden}
        />
      </div>
      <p className="text-[12px] text-muted-foreground">
        Source: KSEI's monthly holdings file. KSEI's local/foreign split can
        differ from IDX's in Shareholders composition.
      </p>
    </section>
  )
}

function Picks<Value extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: ReadonlyArray<{ value: Value; label: string }>
  value: Value
  onPick: (value: Value) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      {options.map((option) => (
        <KChip
          key={option.value}
          selected={option.value === value}
          onSelectedChange={() => onPick(option.value)}
        >
          {option.label}
        </KChip>
      ))}
    </div>
  )
}

// The newest month's local and foreign shares of scripless.
function OriginSummary({ series }: { series: ReadonlyArray<SeriesMonth> }) {
  const split = latestOriginSplit(series)
  if (split === undefined) return null
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            { key: "local", label: "Local", share: split.local },
            { key: "foreign", label: "Foreign", share: 1 - split.local },
          ] as const
        ).map(({ key, label, share }) => (
          <div
            key={key}
            className="flex items-center justify-between rounded-sm border border-border px-3 py-2"
          >
            <span>{label}</span>
            <b
              className="num"
              aria-label={`${label} share`}
              style={{ color: SERIES_COLOR[key] }}
            >
              {percent(share)}
            </b>
          </div>
        ))}
      </div>
      <span className="text-[12px] text-muted-foreground">
        As of {monthLabel(split.periodEnd)}.
      </span>
    </div>
  )
}

type Shown = ReadonlyArray<ChartSeries & { readonly index: number }>

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="mr-1.5 inline-block size-2.5 shrink-0 rounded-[2px]"
      style={{ background: color }}
    />
  )
}

function Bars({
  chart,
  shown,
  origin,
}: {
  chart: HoldingChart
  shown: Shown
  origin: ChartOrigin
}) {
  const scroller = useRef<HTMLDivElement>(null)
  // Opens at the newest month. The page keys the chart by stock, so another
  // stock mounts it again.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [])
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  return (
    <div className="flex min-w-0" role="group" aria-label="Holding chart">
      <div
        aria-hidden
        className="relative w-12 shrink-0 text-[11px] text-muted-foreground"
        style={{ height: HEIGHT + 20 }}
      >
        {ticks.map((tick) => (
          <span
            key={tick}
            className="num absolute right-2 -translate-y-1/2"
            style={{ top: (1 - tick) * HEIGHT }}
          >
            {percentTick(tick * chart.axisMax)}
          </span>
        ))}
      </div>
      <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div className="relative w-max min-w-full">
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-border"
              style={{ top: (1 - tick) * HEIGHT }}
            />
          ))}
          <ol className="relative flex gap-2 px-1">
            {chart.columns.map((column) => (
              <li key={column.month} className="flex flex-col items-center">
                <Column
                  column={column}
                  shown={shown}
                  axisMax={chart.axisMax}
                  origin={origin}
                />
                <span className="num h-5 text-[11px] leading-5 whitespace-nowrap text-muted-foreground">
                  {shortMonth(column.month)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

/** 0.025 → `2.5%` */
const percentTick = (share: number) => `${Number((share * 100).toFixed(2))}%`

function Column({
  column,
  shown,
  axisMax,
  origin,
}: {
  column: ChartColumn
  shown: Shown
  axisMax: number
  origin: ChartOrigin
}) {
  const { shares } = column
  const label = monthLabel(column.month)
  return (
    <KTooltip
      side="right"
      content={
        <div className="flex flex-col gap-1.5">
          <b>{label}</b>
          {shares === undefined ? (
            <span>{NO_DATA}: KSEI's file has no row for this month.</span>
          ) : (
            <>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                {[...shown]
                  .sort(
                    (a, b) => (shares[b.index] ?? 0) - (shares[a.index] ?? 0)
                  )
                  .map((each) => (
                    <div key={each.key} className="contents">
                      <dt className="flex items-center">
                        <Swatch color={SERIES_COLOR[each.key]} />
                        {each.label}
                      </dt>
                      <dd className="num text-right">
                        {percent(shares[each.index] ?? 0)}
                      </dd>
                    </div>
                  ))}
              </dl>
              <span className="text-muted-foreground">
                Share of {ofWhat(origin)}.
              </span>
            </>
          )}
        </div>
      }
    >
      <button
        type="button"
        aria-label={label}
        className={cn(
          "flex flex-col-reverse justify-start rounded-xs",
          COLUMN,
          kFocus
        )}
        style={{ height: HEIGHT }}
      >
        {shares === undefined ? (
          <span className="m-auto rotate-180 text-[10px] whitespace-nowrap text-muted-foreground [writing-mode:vertical-rl]">
            {NO_DATA}
          </span>
        ) : (
          shown.map((each) => (
            <i
              key={each.key}
              className="block w-full shrink-0"
              style={{
                height: ((shares[each.index] ?? 0) / axisMax) * HEIGHT,
                background: SERIES_COLOR[each.key],
              }}
            />
          ))
        )}
      </button>
    </KTooltip>
  )
}

function Table({ chart, shown }: { chart: HoldingChart; shown: Shown }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table aria-label="Holding composition by month" className="w-full">
        <thead>
          <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              Month
            </th>
            {shown.map((each) => (
              <th
                key={each.key}
                scope="col"
                className="px-2 py-1.5 text-right font-semibold whitespace-nowrap"
              >
                <Swatch color={SERIES_COLOR[each.key]} />
                {each.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...chart.columns].reverse().map(({ month, shares }) => (
            <tr key={month} className="border-b border-border">
              <th
                scope="row"
                className="num px-2 py-1.5 text-left font-normal whitespace-nowrap"
              >
                {monthLabel(month)}
              </th>
              {shares === undefined ? (
                <td
                  colSpan={shown.length}
                  className="px-2 py-1.5 text-muted-foreground italic"
                >
                  {NO_DATA}
                </td>
              ) : (
                shown.map((each) => (
                  <td key={each.key} className="num px-2 py-1.5 text-right">
                    {percent(shares[each.index] ?? 0)}
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Legend({
  series,
  hidden,
  origin,
  onHidden,
}: {
  series: ReadonlyArray<ChartSeries>
  hidden: ReadonlySet<SeriesKey>
  origin: ChartOrigin
  onHidden: (hidden: ReadonlySet<SeriesKey>) => void
}) {
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toggle = (key: SeriesKey) => {
    const next = new Set(hidden)
    if (!next.delete(key)) next.add(key)
    onHidden(next)
  }
  // Shows only `key`, or everything when it already is the only one shown.
  const only = (key: SeriesKey) => {
    const alone =
      !hidden.has(key) &&
      series.every((each) => each.key === key || hidden.has(each.key))
    onHidden(
      new Set(
        alone
          ? []
          : series.flatMap((each) => (each.key === key ? [] : [each.key]))
      )
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div role="group" aria-label="Legend" className="flex flex-col gap-0.5">
        {series.map((each) => (
          <button
            key={each.key}
            type="button"
            aria-pressed={!hidden.has(each.key)}
            onClick={(event) => {
              clearTimeout(pending.current)
              // A keyboard press has no double-click to wait for.
              if (event.detail === 0) toggle(each.key)
              else
                pending.current = setTimeout(
                  () => toggle(each.key),
                  DOUBLE_CLICK_MS
                )
            }}
            onDoubleClick={() => {
              clearTimeout(pending.current)
              only(each.key)
            }}
            className={cn(
              "hover:bg-elevated flex items-center rounded-xs px-1.5 py-1 text-left text-[12px] select-none",
              "aria-[pressed=false]:line-through aria-[pressed=false]:opacity-40",
              kFocus
            )}
          >
            <Swatch color={SERIES_COLOR[each.key]} />
            {each.label}
          </button>
        ))}
      </div>
      <p className="px-1.5 text-[12px] text-muted-foreground">
        Click hides · double-click shows only that one. Columns are % of{" "}
        {ofWhat(origin)}
        {hidden.size > 0 && "; the axis zooms to the shown series"}.
      </p>
    </div>
  )
}
