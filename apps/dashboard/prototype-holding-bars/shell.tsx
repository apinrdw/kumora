// PROTOTYPE (wayfinder #382), throwaway: a copy of
// src/components/stocks/holding-composition.tsx whose Bars view is swapped
// per variant. Everything but `bars` is today's code.
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type React from "react"
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
import { monthLabel, percent, TYPE_COLOR } from "@/lib/stock-page-display"
import type { ChartView, OriginShown } from "@/lib/stock-search"
import type { SeriesMonth } from "@/server/holdings/stock-page"

const NO_DATA = "No data"

const SERIES_COLOR: Record<SeriesKey, string> = {
  local: "var(--origin-local)",
  foreign: "var(--origin-foreign)",
  ...TYPE_COLOR,
}

const ORIGINS: ReadonlyArray<{ value: OriginShown; label: string }> = [
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

const NONE_HIDDEN: ReadonlySet<SeriesKey> = new Set()

const ofWhat = (origin: OriginShown) =>
  Effect.succeed(
    origin === "all" ? "scripless shares" : `all ${origin} holdings`
  )

/** `2026-10` → `Oct 26` */
const shortMonth = (month: string) =>
  Effect.map(
    monthLabel(month),
    (label) => `${label.slice(0, 4)}${month.slice(2, 4)}`
  )

export type BarsProps = {
  chart: HoldingChart
  shown: Shown
  origin: OriginShown
}
export {
  SERIES_COLOR,
  ofWhat,
  shortMonth,
  percentTick,
  NO_DATA,
  HEIGHT,
  Swatch,
  Column as TodayColumn,
}
export type { Shown }

export type HoldingCompositionProps = {
  bars: (props: BarsProps) => React.ReactNode
  series: ReadonlyArray<SeriesMonth>
  origin: OriginShown
  view: ChartView
  onOrigin: (origin: OriginShown) => void
  onView: (view: ChartView) => void
}

export function HoldingComposition({
  bars,
  series,
  origin,
  view,
  onOrigin,
  onView,
}: HoldingCompositionProps) {
  // Decision: hidden series last one origin view. Every origin change shows
  // every series again, reset during render rather than keying the chart by
  // origin, which would remount the bars and lose their scroll.
  const [hidden, setHidden] = useState(NONE_HIDDEN)
  const [hiddenIn, setHiddenIn] = useState(origin)
  if (hiddenIn !== origin) {
    setHiddenIn(origin)
    setHidden(NONE_HIDDEN)
  }
  const chart = Effect.runSync(holdingChart(series, origin, hidden))
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
          bars({ chart, shown, origin })
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
        Source: KSEI's monthly Securities holdings report. KSEI's local/foreign
        split can differ from IDX's in Shareholders composition.
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
  const latest = Effect.runSync(latestOriginSplit(series))
  if (latest === undefined) return null
  const month = Effect.runSync(monthLabel(latest.periodEnd))
  if (latest.split === undefined)
    return (
      <p className="text-[12px] text-muted-foreground">
        Unavailable: KSEI lists no scripless shares for {month}.
      </p>
    )
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            { key: "local", label: "Local", share: latest.split.left },
            { key: "foreign", label: "Foreign", share: latest.split.right },
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
              {Effect.runSync(percent(share))}
            </b>
          </div>
        ))}
      </div>
      <span className="text-[12px] text-muted-foreground">As of {month}.</span>
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

export function TodayBars({
  chart,
  shown,
  origin,
}: {
  chart: HoldingChart
  shown: Shown
  origin: OriginShown
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
            {Effect.runSync(percentTick(tick * chart.axisMax))}
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
                  {Effect.runSync(shortMonth(column.month))}
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
const percentTick = (share: number) =>
  Effect.succeed(`${Number((share * 100).toFixed(2))}%`)

function Column({
  column,
  shown,
  axisMax,
  origin,
}: {
  column: ChartColumn
  shown: Shown
  axisMax: number
  origin: OriginShown
}) {
  const { shares } = column
  const label = Effect.runSync(monthLabel(column.month))
  return (
    <KTooltip
      side="right"
      content={
        <div className="flex flex-col gap-1.5">
          <b>{label}</b>
          {shares === undefined ? (
            <span>{NO_DATA}: KSEI's report has no row for this month.</span>
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
                        {Effect.runSync(percent(shares[each.index] ?? 0))}
                      </dd>
                    </div>
                  ))}
              </dl>
              <span className="text-muted-foreground">
                Share of {Effect.runSync(ofWhat(origin))}.
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
                {Effect.runSync(monthLabel(month))}
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
                    {Effect.runSync(percent(shares[each.index] ?? 0))}
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
  origin: OriginShown
  onHidden: (hidden: ReadonlySet<SeriesKey>) => void
}) {
  // The hidden set as it was before the last click, which a double-click's
  // second click decides from.
  // Decision: a click hides or shows its series at once, and a double-click
  // replaces whatever its first click did: a click that waited out a timer
  // for a double-click was applied anyway when the browser counted a
  // slower one, so double-clicking an entry shown alone isolated it again.
  const beforeClick = useRef(hidden)
  const onClick = (key: SeriesKey, clicks: number) => {
    if (clicks === 2) {
      const before = beforeClick.current
      const alone =
        !before.has(key) &&
        series.every((each) => each.key === key || before.has(each.key))
      onHidden(
        new Set(
          alone
            ? []
            : series.flatMap((each) => (each.key === key ? [] : [each.key]))
        )
      )
      return
    }
    // A keyboard press counts no clicks; a third click does nothing.
    if (clicks > 2) return
    beforeClick.current = hidden
    const next = new Set(hidden)
    if (!next.delete(key)) next.add(key)
    onHidden(next)
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div role="group" aria-label="Legend" className="flex flex-col gap-0.5">
        {series.map((each) => (
          <button
            key={each.key}
            type="button"
            aria-pressed={!hidden.has(each.key)}
            onClick={(event) => onClick(each.key, event.detail)}
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
        {Effect.runSync(ofWhat(origin))}
        {hidden.size > 0 && "; the axis zooms to the shown series"}.
      </p>
    </div>
  )
}
