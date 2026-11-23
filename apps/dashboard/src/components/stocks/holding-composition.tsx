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
  type ChartInteractionController,
  type ChartPoint,
} from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react/tooltip"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { portal } from "@tanstack/charts/tooltip/portal"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { kCard, kFocus, kTooltip } from "@/components/k/styles"
import { Picks } from "@/components/stocks/choice"
import {
  type ChartSeries,
  type HoldingChart,
  holdingChart,
  type HoldingRow,
  holdingRows,
  latestOriginSplit,
  type MonthChange,
  monthChange,
  type SeriesKey,
} from "@/lib/holding-composition"
import {
  monthLabel,
  percent,
  shortMonth,
  TYPE_COLOR,
} from "@/lib/stock-page-display"
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
  // Hidden series last one origin view. Every origin change shows
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
type BarsPoint = ChartPoint<HoldingRow | MonthStop, string, number>

/** 0.025 → `2.5%` */
const percentTick = (share: number) =>
  Effect.succeed(`${Number((share * 100).toFixed(2))}%`)

// What the tooltip shows for one month: its shown series largest first
// with how they moved from the month before, or nothing for a month KSEI
// has no data for.
type MonthView =
  | { readonly month: string; readonly rows: undefined }
  | {
      readonly month: string
      readonly rows: ReadonlyArray<HoldingRow>
      readonly change: MonthChange
    }

const monthView = Effect.fnUntraced(function* (
  chart: HoldingChart,
  rows: ReadonlyArray<HoldingRow>,
  month: string
): Effect.fn.Return<MonthView> {
  if (
    chart.columns.find((column) => column.month === month)?.shares === undefined
  )
    return { month, rows: undefined }
  const monthRows = rows.filter((row) => row.month === month)
  return {
    month,
    rows: [...monthRows].sort((a, b) => b.share - a.share),
    change: yield* monthChange(
      chart,
      month,
      monthRows.map(({ key }) => key)
    ),
  }
})

// Every month's tooltip, built once for both its body and its text.
const monthViews = (chart: HoldingChart, rows: ReadonlyArray<HoldingRow>) =>
  Effect.map(
    Effect.forEach(chart.columns, ({ month }) => monthView(chart, rows, month)),
    (views) => new Map(views.map((view) => [view.month, view]))
  )

type Direction = "up" | "down"

// How a series' share moved from the month before.
type Move = { readonly was: number; readonly direction: Direction }

const MOVE_STYLE: Record<Direction, { className: string; arrow: string }> = {
  up: { className: "text-up", arrow: "▲" },
  down: { className: "text-down", arrow: "▼" },
}

// A series' move, or undefined when its share printed the same as the
// month before's or there is no month before to compare.
const seriesMove = (
  change: MonthChange,
  key: SeriesKey,
  now: number
): Effect.Effect<Move | undefined> => {
  const was = change._tag === "From" ? change.was.get(key) : undefined
  return Effect.succeed(
    was === undefined
      ? undefined
      : { was, direction: now > was ? "up" : "down" }
  )
}

/** `up from 53.45%` */
const moveText = (move: Move) =>
  Effect.map(percent(move.was), (was) => `${move.direction} from ${was}`)

// Why a month shows no changes, when there is no month before to compare.
const changeNote = Effect.fnUntraced(function* (change: MonthChange) {
  switch (change._tag) {
    case "From":
      return undefined
    case "NoData":
      return `${yield* monthLabel(change.month)} has no data, so no change is shown.`
    case "First":
      return "This is the first month KSEI has for this stock."
  }
})

// One series' line in the tooltip's screen-reader text.
const rowText = Effect.fnUntraced(function* (
  row: HoldingRow,
  move: Move | undefined
) {
  const line = `${row.label} ${yield* percent(row.share)}`
  if (move === undefined) return line
  return `${line}, ${yield* moveText(move)}`
})

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
  for (const row of view.rows)
    lines.push(
      yield* rowText(row, yield* seriesMove(view.change, row.key, row.share))
    )
  lines.push(`Share of ${yield* ofWhat(origin)}.`)
  const note = yield* changeNote(view.change)
  if (note !== undefined) lines.push(note)
  return lines.join("\n")
})

function MonthBody({ view, origin }: { view: MonthView; origin: OriginShown }) {
  const note =
    view.rows === undefined
      ? undefined
      : Effect.runSync(changeNote(view.change))
  return (
    <div className={cn(kTooltip, "flex flex-col gap-1.5")}>
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
                <dd className="num text-right whitespace-nowrap">
                  <WasNow
                    now={row.share}
                    move={Effect.runSync(
                      seriesMove(view.change, row.key, row.share)
                    )}
                  />
                </dd>
              </div>
            ))}
          </dl>
          <span className="text-muted-foreground">
            Share of {Effect.runSync(ofWhat(origin))}.
            {note !== undefined && ` ${note}`}
          </span>
        </>
      )}
    </div>
  )
}

// A share as `last month → this month`, as Shareholders composition writes
// a change, with this month's colored by its direction.
function WasNow({ now, move }: { now: number; move: Move | undefined }) {
  return (
    <>
      {move !== undefined && (
        <span className="text-muted-foreground">
          {Effect.runSync(percent(move.was))} →{" "}
        </span>
      )}
      <span className={move && MOVE_STYLE[move.direction].className}>
        {Effect.runSync(percent(now))}
      </span>
    </>
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
  const interaction =
    useRef<ChartInteractionController<HoldingRow | MonthStop, string, number>>(
      null
    )
  const scenePoints = useRef<ReadonlyArray<BarsPoint>>([])
  // The keyboard month is our index into the months, set by
  // month on hover, not the library's focused point: the library stepped
  // from a hovered segment, which its month navigation lacks, to the first
  // month. Keys and keyboard focus move the index and focus that month's
  // own stop.
  const at = useRef(0)
  const [showing, setShowing] = useState(false)
  // While a month shows, Escape anywhere on the page hides it and
  // keeps focus where it was, as KTooltip did, whether hover, focus or tap
  // showed it; the next arrow key steps from the month it hid, and the next
  // pointer move over a month shows it again. The library dismisses on
  // Escape only a pinned tooltip, and this one never pins.
  useEffect(() => {
    if (!showing) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") interaction.current?.setControlledFocus(null)
    }
    document.addEventListener("keydown", dismiss)
    return () => document.removeEventListener("keydown", dismiss)
  }, [showing])
  const stops = useMemo(
    () => chart.columns.map(({ month }): MonthStop => ({ month })),
    [chart]
  )
  const rows = useMemo(
    () => Effect.runSync(holdingRows(chart, shown)),
    [chart, shown]
  )
  const views = useMemo(
    () => Effect.runSync(monthViews(chart, rows)),
    [chart, rows]
  )
  const definition = useMemo(() => {
    const months = stops.map(({ month }) => month)
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
          // The y-axis labels are our own rail beside the
          // scroller, not the chart's axis labels, which would scroll away
          // with the columns. The chart's axis keeps only its tick values,
          // to place the gridlines level with the rail's.
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
      // The chart is one tab stop whose arrow keys step the
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
        // A click or Enter never pins the tooltip. It shows on
        // hover, focus and tap and goes when they leave, as KTooltip did.
        sticky: false,
        className: "holding-tooltip",
        formatGroup: (points) => {
          const view = views.get(String(points[0]?.xValue))
          return view === undefined
            ? ""
            : Effect.runSync(monthText(view, origin))
        },
      },
    })
  }, [chart, stops, shown, origin, rows, views])
  // A month focused by key near or past the scroller's edge
  // scrolls to the middle; a hovered one never scrolls. The library scrolls
  // nothing itself, and following hover as well jumped the columns half a
  // view under the pointer.
  const focusMonth = (index: number) => {
    const point = scenePoints.current.find(
      (each) => each.datum === stops[index]
    )
    if (point === undefined) return
    at.current = index
    interaction.current?.setControlledFocus(point)
    const element = scroller.current
    if (
      element &&
      (point.x < element.scrollLeft + PITCH ||
        point.x > element.scrollLeft + element.clientWidth - PITCH)
    )
      element.scrollLeft = point.x - element.clientWidth / 2
  }
  return (
    <div className="flex min-w-0">
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
      <div
        ref={scroller}
        className="min-w-0 flex-1 overflow-x-auto pb-1"
        onKeyDownCapture={(event) => {
          const last = stops.length - 1
          const step: Partial<Record<string, number>> = {
            ArrowLeft: at.current - 1,
            ArrowUp: at.current - 1,
            ArrowRight: at.current + 1,
            ArrowDown: at.current + 1,
            Home: 0,
            End: last,
          }
          const to = step[event.key]
          if (to === undefined) return
          // The library's own arrow keys would step from its focused point.
          event.preventDefault()
          event.stopPropagation()
          focusMonth(Math.min(last, Math.max(0, to)))
        }}
        onFocusCapture={(event) => {
          if (event.target.matches(":focus-visible")) focusMonth(at.current)
        }}
        // The library clears on blur only a month its own keys focused, so
        // the chart clears the one it focused, and the tooltip goes with
        // focus.
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            interaction.current?.setControlledFocus(null)
        }}
      >
        <Chart
          definition={definition}
          ariaLabel="Holding composition by month. Arrow keys step through the months; the Table view lists every value."
          width={chart.columns.length * PITCH}
          height={HEIGHT + X_AXIS}
          className="text-muted-foreground"
          onRender={(context) => {
            interaction.current = context.interaction
            scenePoints.current = context.scene.points
          }}
          onFocusGroupChange={(group) => {
            setShowing(group.length > 0)
            const index = stops.findIndex(
              ({ month }) => month === group[0]?.xValue
            )
            if (index >= 0) at.current = index
          }}
          renderTooltipBody={({ points }) => {
            const view = views.get(String(points[0]?.xValue))
            return view && <MonthBody view={view} origin={origin} />
          }}
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
                  shown.map((each) => {
                    const now = shares[each.index] ?? 0
                    return (
                      <td key={each.key} className="num px-2 py-1.5 text-right">
                        <ShareChange
                          now={now}
                          move={Effect.runSync(
                            seriesMove(change, each.key, now)
                          )}
                        />
                      </td>
                    )
                  })
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// A share, with an arrow and color when it moved from the month before.
function ShareChange({ now, move }: { now: number; move: Move | undefined }) {
  const nowText = Effect.runSync(percent(now))
  if (move === undefined) return nowText
  const style = MOVE_STYLE[move.direction]
  return (
    <span className={style.className}>
      <span aria-hidden className="mr-1 text-[10px]">
        {style.arrow}
      </span>
      {nowText}
      <span className="sr-only">, {Effect.runSync(moveText(move))}</span>
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
  // A click hides or shows its series at once, and a double-click
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
