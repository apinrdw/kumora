// The stock page's Holding composition (scripless) chart (spec
// apinrdw/kumora#363, stories 29–42; prototype variant D): KSEI's holdings
// of the stock per month, as stacked columns or a table, with a legend that
// hides series.
import {
  bandX,
  barY,
  defineChart,
  stack,
  text,
  whenFocused,
} from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react/tooltip"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { portal } from "@tanstack/charts/tooltip/portal"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { KChip } from "@/components/k/chip"
import { kCard, kFocus } from "@/components/k/styles"
import {
  type ChartSeries,
  type HoldingChart,
  holdingChart,
  type HoldingRow,
  holdingRows,
  latestOriginSplit,
  monthChange,
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

// The bars' height in px, the month labels' below them, and a column's
// width and pitch: 36 px wide with an 8 px gap.
const HEIGHT = 240
const X_AXIS = 20
const COLUMN = 36
const PITCH = 44

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

export type HoldingCompositionProps = {
  series: ReadonlyArray<SeriesMonth>
  origin: OriginShown
  view: ChartView
  onOrigin: (origin: OriginShown) => void
  onView: (view: ChartView) => void
}

export function HoldingComposition({
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
  // Memoized so the Bars' chart definition is rebuilt only when these change.
  const chart = useMemo(
    () => Effect.runSync(holdingChart(series, origin, hidden)),
    [series, origin, hidden]
  )
  const shown = useMemo(
    () =>
      chart.series.flatMap((each, index) =>
        hidden.has(each.key) ? [] : [{ ...each, index }]
      ),
    [chart, hidden]
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

// A month's column for the chart's hover and keyboard stops.
type MonthStop = { readonly month: string }

/** 0.025 → `2.5%` */
const percentTick = (share: number) =>
  Effect.succeed(`${Number((share * 100).toFixed(2))}%`)

// What the tooltip shows for one month: its shown series largest first, or
// nothing for a month KSEI has no data for.
type MonthView =
  | { readonly month: string; readonly rows: undefined }
  | { readonly month: string; readonly rows: ReadonlyArray<HoldingRow> }

const monthView = (
  chart: HoldingChart,
  rows: ReadonlyArray<HoldingRow>,
  month: string
) =>
  Effect.sync((): MonthView => ({
    month,
    rows:
      chart.columns.find((column) => column.month === month)?.shares ===
      undefined
        ? undefined
        : rows
            .filter((row) => row.month === month)
            .sort((a, b) => b.share - a.share),
  }))

// One series' line in the tooltip's screen-reader text.
const rowText = (row: HoldingRow) =>
  Effect.map(percent(row.share), (share) => `${row.label} ${share}`)

// The tooltip as plain text, for its `role="status"` label: the React body
// is inert while the tooltip is transient, so a screen reader hears this.
const monthText = Effect.fnUntraced(function* (
  view: MonthView,
  origin: OriginShown
) {
  const label = yield* monthLabel(view.month)
  if (view.rows === undefined)
    return `${label}: ${NO_DATA}, KSEI's report has no row for this month.`
  const lines = [label]
  for (const row of view.rows) lines.push(yield* rowText(row))
  lines.push(`Share of ${yield* ofWhat(origin)}.`)
  return lines.join("\n")
})

function MonthBody({ view, origin }: { view: MonthView; origin: OriginShown }) {
  return (
    <div className="flex flex-col gap-1.5">
      <b>{Effect.runSync(monthLabel(view.month))}</b>
      {view.rows === undefined ? (
        <span>{NO_DATA}: KSEI's report has no row for this month.</span>
      ) : (
        <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {view.rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="flex items-center">
                  <Swatch color={SERIES_COLOR[row.key]} />
                  {row.label}
                </dt>
                <dd className="num text-right">
                  {Effect.runSync(percent(row.share))}
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
  )
}

const TICKS = [1, 0.75, 0.5, 0.25, 0]

function Bars({
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
  const rows = useMemo(
    () => Effect.runSync(holdingRows(chart, shown)),
    [chart, shown]
  )
  const definition = useMemo(() => {
    const months = chart.columns.map(({ month }) => month)
    const stops: Array<MonthStop> = months.map((month) => ({ month }))
    const gaps: Array<MonthStop> = chart.columns.flatMap(({ month, shares }) =>
      shares === undefined ? [{ month }] : []
    )
    const keys = shown.map(({ key }) => key)
    return defineChart({
      marks: [
        // An invisible band per month, so a month with no bars is a hover
        // and keyboard stop too.
        bandX(stops, { x: "month", fillOpacity: 0 }),
        whenFocused(
          bandX(stops, {
            x: "month",
            fill: "var(--text-muted)",
            fillOpacity: 0.12,
            inset: -3,
            radius: 2,
          }),
          { match: "x" }
        ),
        // The first shown series sits at the bottom.
        barY(rows, {
          x: "month",
          y: "share",
          color: "key",
          layout: stack({ order: keys }),
        }),
        text(gaps, {
          x: "month",
          y: () => chart.axisMax / 2,
          text: () => NO_DATA,
          rotate: -90,
          fontSize: 10,
          fill: "var(--text-muted)",
        }),
      ],
      scales: {
        x: {
          scale: scaleBand<string>()
            .domain(months)
            .paddingInner((PITCH - COLUMN) / PITCH)
            .paddingOuter((PITCH - COLUMN) / 2 / PITCH),
          axis: {
            line: false,
            ticks: {
              size: 0,
              format: (month: string) => Effect.runSync(shortMonth(month)),
            },
            tickLabels: { thin: false, fontSize: 11, opacity: 1 },
          },
        },
        y: {
          scale: scaleLinear().domain([0, chart.axisMax]),
          // Decision: the y-axis labels are our own rail beside the
          // scroller, so they stay put while the columns scroll. The chart's
          // axis draws no line or labels; its tick values only place the
          // gridlines level with the rail's.
          axis: {
            line: false,
            ticks: {
              values: TICKS.map((tick) => tick * chart.axisMax),
              size: 0,
            },
            tickLabels: false,
          },
          grid: {
            strokeDasharray: "3 3",
            stroke: "var(--border-subtle)",
            strokeOpacity: 1,
          },
        },
      },
      color: {
        domain: keys,
        range: shown.map(({ key }) => SERIES_COLOR[key]),
      },
      margin: { left: 0, right: 0, top: 0, bottom: X_AXIS },
      // Decision: the chart is one tab stop whose arrow keys step the
      // months, not a button per month; the Table view lists every exact
      // value for anyone who wants them as cells.
      focus: "group-x",
      focusRing: false,
      keyboard: true,
      tooltip: {
        use: tooltip,
        portal,
        anchor: "group-center",
        placement: ["right", "left"],
        // Decision: a click or Enter never pins the tooltip. It shows on
        // hover, focus and tap and goes when they leave, as KTooltip did.
        sticky: false,
        className: "holding-tooltip",
        formatGroup: (points) =>
          Effect.runSync(
            Effect.flatMap(
              monthView(chart, rows, String(points[0]?.xValue ?? "")),
              (view) => monthText(view, origin)
            )
          ),
      },
    })
  }, [chart, shown, origin, rows])
  return (
    <div className="flex min-w-0" role="group" aria-label="Holding chart">
      <div
        aria-hidden
        className="relative w-12 shrink-0 text-[11px] text-muted-foreground"
        style={{ height: HEIGHT + X_AXIS }}
      >
        {TICKS.map((tick) => (
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
        <Chart
          definition={definition}
          ariaLabel="Holding composition by month. Arrow keys step through the months; the Table view lists every value."
          width={chart.columns.length * PITCH}
          height={HEIGHT + X_AXIS}
          className="text-muted-foreground"
          // Decision: our code scrolls a keyboard-focused month into view
          // when it is near or past the scroller's edge; the library does
          // not scroll its overflow container.
          onFocusGroupChange={(points) => {
            const element = scroller.current
            const x = points[0]?.x
            if (!element || x === undefined) return
            if (
              x < element.scrollLeft + PITCH ||
              x > element.scrollLeft + element.clientWidth - PITCH
            )
              element.scrollLeft = x - element.clientWidth / 2
          }}
          renderTooltipBody={({ points }) => (
            <MonthBody
              view={Effect.runSync(
                monthView(chart, rows, String(points[0]?.xValue ?? ""))
              )}
              origin={origin}
            />
          )}
        />
      </div>
    </div>
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
          {[...chart.columns].reverse().map(({ month, shares }) => {
            const change = Effect.runSync(
              monthChange(
                chart,
                month,
                shown.map(({ key }) => key)
              )
            )
            return (
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
                      <ShareChange
                        now={shares[each.index] ?? 0}
                        was={
                          change._tag === "From"
                            ? change.was.get(each.key)
                            : undefined
                        }
                      />
                    </td>
                  ))
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A share, with an arrow and color when it moved from `was`.
function ShareChange({ now, was }: { now: number; was: number | undefined }) {
  const shown = Effect.runSync(percent(now))
  if (was === undefined) return shown
  const up = now > was
  return (
    <span className={up ? "text-up" : "text-down"}>
      <span aria-hidden className="mr-1 text-[10px]">
        {up ? "▲" : "▼"}
      </span>
      {shown}
      <span className="sr-only">
        , {up ? "up" : "down"} from {Effect.runSync(percent(was))}
      </span>
    </span>
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
