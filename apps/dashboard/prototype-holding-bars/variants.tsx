// PROTOTYPE (wayfinder #382), throwaway: three ways TanStack Charts could
// draw Holding composition's Bars.
//   A · Native: the chart is one tab stop; arrow keys step months; the
//       library's tooltip shows our sorted body.
//   B · Buttons: the chart only paints; a transparent button per month sits
//       over it with today's KTooltip, so each month stays its own tab stop.
//   C · Readout: no floating tooltip; hovering, tapping or arrowing a month
//       fills a readout above the chart, which starts at the newest month.
import {
  bandX,
  barY,
  defineChart,
  stack,
  text,
  whenFocused,
} from "@tanstack/charts"
import type { ChartPoint } from "@tanstack/charts/react/tooltip"
import { Chart } from "@tanstack/charts/react/tooltip"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { portal } from "@tanstack/charts/tooltip/portal"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type React from "react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import type { ChartColumn } from "@/lib/holding-composition"
import { monthLabel, percent } from "@/lib/stock-page-display"

import {
  type BarsProps,
  HEIGHT,
  NO_DATA,
  ofWhat,
  percentTick,
  SERIES_COLOR,
  type Shown,
  shortMonth,
  Swatch,
} from "./shell"

// Today's pitch: a 36px column and an 8px gap.
const PITCH = 44
const COLUMN = 36
const X_AXIS = 20
const TICKS = [1, 0.75, 0.5, 0.25, 0]

type Row = {
  readonly month: string
  readonly key: string
  readonly label: string
  readonly share: number
}
type MonthRow = { readonly month: string }

const label = (month: string) => Effect.runSync(monthLabel(month))
const short = (month: string) => Effect.runSync(shortMonth(month))
const pct = (share: number) => Effect.runSync(percent(share))

function rowsOf(columns: ReadonlyArray<ChartColumn>, shown: Shown) {
  const rows: Array<Row> = []
  for (const { month, shares } of columns)
    if (shares)
      for (const each of shown)
        rows.push({
          month,
          key: each.key,
          label: each.label,
          share: shares[each.index] ?? 0,
        })
  return rows
}

type Mode = "native" | "paint" | "readout"

function useDefinition({ chart, shown, origin }: BarsProps, mode: Mode) {
  return useMemo(() => {
    const months = chart.columns.map((column) => column.month)
    const rows = rowsOf(chart.columns, shown)
    const allMonths: Array<MonthRow> = months.map((month) => ({ month }))
    const gaps: Array<MonthRow> = chart.columns
      .filter((column) => column.shares === undefined)
      .map(({ month }) => ({ month }))
    const keys = shown.map((each) => each.key)
    const interactive = mode !== "paint"
    return defineChart({
      marks: [
        // An invisible band per month: a hover and keyboard stop even for a
        // month with no bars.
        ...(interactive
          ? [bandX(allMonths, { x: "month", fillOpacity: 0 })]
          : []),
        ...(interactive
          ? [
              whenFocused(
                bandX(allMonths, {
                  x: "month",
                  fill: "var(--text-muted)",
                  fillOpacity: 0.12,
                  inset: -3,
                  radius: 2,
                }),
                { match: "x" }
              ),
            ]
          : []),
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
            .paddingOuter(0.1),
          axis: {
            line: false,
            ticks: { size: 0, format: (month: string) => short(month) },
            tickLabels: { thin: false, fontSize: 11 },
          },
        },
        y: {
          scale: scaleLinear().domain([0, chart.axisMax]),
          axis: false,
          grid: { strokeDasharray: "3 3", stroke: "var(--border-subtle)" },
        },
      },
      color: {
        domain: keys,
        range: shown.map((each) => SERIES_COLOR[each.key]),
      },
      margin: { left: 0, right: 0, top: 0, bottom: X_AXIS },
      focus: interactive ? "group-x" : false,
      focusRing: false,
      keyboard: interactive,
      svgAnimation: mode === "readout",
      ...(mode === "native"
        ? {
            tooltip: {
              use: tooltip,
              portal,
              anchor: "group-center",
              placement: ["right", "left"],
              sticky: false,
              className: "proto-tooltip",
              // What a screen reader hears, since the React body is inert.
              formatGroup: (points: ReadonlyArray<ChartPoint>) =>
                groupText(points, origin, chart.columns, shown),
            },
          }
        : {}),
    })
  }, [chart, shown, origin, mode])
}

const monthOf = (points: ReadonlyArray<ChartPoint>) =>
  String(points[0]?.xValue ?? "")

const sharesOf = (points: ReadonlyArray<ChartPoint>) =>
  points
    .flatMap((point) => {
      const datum = point.datum as Partial<Row>
      return datum.key === undefined ? [] : [datum as Row]
    })
    .sort((a, b) => b.share - a.share)

// Each shown series' change from the previous calendar month, in percentage
// points, or why there is none (first month, or the month before has no data).
type Change =
  | { readonly from: string; readonly by: ReadonlyMap<string, number> }
  | { readonly from: string; readonly missing: true }
  | { readonly first: true }

function changeOf(
  columns: ReadonlyArray<ChartColumn>,
  shown: Shown,
  month: string
): Change {
  const index = columns.findIndex((column) => column.month === month)
  const before = columns[index - 1]
  if (before === undefined) return { first: true }
  const now = columns[index]?.shares
  if (before.shares === undefined || now === undefined)
    return { from: before.month, missing: true }
  return {
    from: before.month,
    by: new Map(
      shown.map((each) => [
        each.key,
        (now[each.index] ?? 0) - (before.shares![each.index] ?? 0),
      ])
    ),
  }
}

/** 0.0042 → `+0.42 pp` */
const pp = (delta: number) => {
  const points = Math.round(delta * 10000) / 100
  return `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points).toFixed(2)} pp`
}

const changeNote = (change: Change) =>
  "first" in change
    ? "First month KSEI has for this stock."
    : "missing" in change
      ? `${label(change.from)} has no data, so no change is shown.`
      : `Changes are from ${label(change.from)}.`

function groupText(
  points: ReadonlyArray<ChartPoint>,
  origin: BarsProps["origin"],
  columns: ReadonlyArray<ChartColumn>,
  shown: Shown
) {
  const month = monthOf(points)
  const rows = sharesOf(points)
  if (rows.length === 0)
    return `${label(month)}: ${NO_DATA}, KSEI's report has no row for this month.`
  const change = changeOf(columns, shown, month)
  const by = "by" in change ? change.by : undefined
  return [
    label(month),
    ...rows.map((row) => {
      const delta = by?.get(row.key)
      return `${row.label} ${pct(row.share)}${delta === undefined ? "" : `, ${pp(delta)}`}`
    }),
    `Share of ${Effect.runSync(ofWhat(origin))}.`,
    changeNote(change),
  ].join("\n")
}

function MonthBody({
  month,
  rows,
  origin,
  change,
}: {
  month: string
  rows: ReadonlyArray<Row>
  origin: BarsProps["origin"]
  change?: Change
}) {
  const by = change && "by" in change ? change.by : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <b>{label(month)}</b>
      {rows.length === 0 ? (
        <span>{NO_DATA}: KSEI's report has no row for this month.</span>
      ) : (
        <>
          <dl
            className={cn(
              "grid gap-x-3 gap-y-0.5",
              by ? "grid-cols-[1fr_auto_auto]" : "grid-cols-[1fr_auto]"
            )}
          >
            {rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="flex items-center">
                  <Swatch
                    color={SERIES_COLOR[row.key as keyof typeof SERIES_COLOR]}
                  />
                  {row.label}
                </dt>
                <dd className="num text-right">{pct(row.share)}</dd>
                {by && (
                  <dd
                    className={cn(
                      "num text-right",
                      (by.get(row.key) ?? 0) > 0.00005
                        ? "text-up"
                        : (by.get(row.key) ?? 0) < -0.00005
                          ? "text-down"
                          : "text-muted-foreground"
                    )}
                  >
                    {pp(by.get(row.key) ?? 0)}
                  </dd>
                )}
              </div>
            ))}
          </dl>
          <span className="text-muted-foreground">
            Share of {Effect.runSync(ofWhat(origin))}.
            {change && <> {changeNote(change)}</>}
          </span>
        </>
      )}
    </div>
  )
}

// The y-axis rail outside the scroller, so it stays put while columns
// scroll. Tick positions match the chart's: same height, same domain.
function Rail({ axisMax }: { axisMax: number }) {
  return (
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
          {Effect.runSync(percentTick(tick * axisMax))}
        </span>
      ))}
    </div>
  )
}

function useScrollToNewest() {
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [])
  return scroller
}

// Keyboard focus can land on a month scrolled out of view; bring it back.
// Our code: the library doesn't scroll its overflow container.
function follow(
  scroller: React.RefObject<HTMLDivElement | null>,
  points: ReadonlyArray<ChartPoint>
) {
  const element = scroller.current
  const x = points[0]?.x
  if (!element || x === undefined) return
  if (
    x < element.scrollLeft + PITCH ||
    x > element.scrollLeft + element.clientWidth - PITCH
  )
    element.scrollLeft = x - element.clientWidth / 2
}

const widthOf = (months: number) => Math.round(months * PITCH + PITCH * 0.2)

export function VariantA(props: BarsProps) {
  const definition = useDefinition(props, "native")
  const scroller = useScrollToNewest()
  return (
    <div className="flex min-w-0" role="group" aria-label="Holding chart">
      <Rail axisMax={props.chart.axisMax} />
      <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <Chart
          definition={definition}
          ariaLabel="Holding composition by month. Arrow keys step through the months; the Table view lists every value."
          width={widthOf(props.chart.columns.length)}
          height={HEIGHT + X_AXIS}
          className={cn("text-muted-foreground", "proto-chart")}
          onFocusGroupChange={(points) => follow(scroller, points)}
          renderTooltipBody={({ points }) => (
            <MonthBody
              month={monthOf(points)}
              rows={sharesOf(points)}
              origin={props.origin}
              change={changeOf(
                props.chart.columns,
                props.shown,
                monthOf(points)
              )}
            />
          )}
        />
      </div>
    </div>
  )
}

export function VariantB(props: BarsProps) {
  const definition = useDefinition(props, "paint")
  const scroller = useScrollToNewest()
  const [bands, setBands] = useState<
    ReadonlyArray<{ month: string; x: number; width: number }>
  >([])
  const columns = props.chart.columns
  return (
    <div className="flex min-w-0" role="group" aria-label="Holding chart">
      <Rail axisMax={props.chart.axisMax} />
      <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div className="relative w-max">
          <Chart
            definition={definition}
            ariaLabel="Holding composition by month"
            tabIndex={-1}
            width={widthOf(columns.length)}
            height={HEIGHT + X_AXIS}
            className="text-muted-foreground"
            onRender={({ scene }) => {
              const x = scene.scales["x"]
              const next = columns.map(({ month }) => {
                const start = Number(x?.map(month) ?? 0)
                return { month, x: start, width: COLUMN }
              })
              setBands((before) =>
                before.length === next.length &&
                before.every((band, i) => band.x === next[i]!.x)
                  ? before
                  : next
              )
            }}
          />
          <ol className="absolute inset-x-0 top-0" style={{ height: HEIGHT }}>
            {bands.map((band, i) => {
              const column = columns[i]!
              const rows = column.shares
                ? [...props.shown]
                    .map((each) => ({
                      month: column.month,
                      key: each.key,
                      label: each.label,
                      share: column.shares![each.index] ?? 0,
                    }))
                    .sort((a, b) => b.share - a.share)
                : []
              return (
                <li
                  key={band.month}
                  className="absolute top-0"
                  style={{ left: band.x, width: band.width, height: HEIGHT }}
                >
                  <KTooltip
                    side="right"
                    content={
                      <MonthBody
                        month={band.month}
                        rows={rows}
                        origin={props.origin}
                      />
                    }
                  >
                    <button
                      type="button"
                      aria-label={label(band.month)}
                      className={cn(
                        "size-full rounded-xs hover:bg-white/5",
                        kFocus
                      )}
                    />
                  </KTooltip>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    </div>
  )
}

export function VariantC(props: BarsProps) {
  const definition = useDefinition(props, "readout")
  const scroller = useScrollToNewest()
  const newest = props.chart.columns.at(-1)?.month ?? ""
  const [month, setMonth] = useState<string | undefined>(undefined)
  const shown = month ?? newest
  const column = props.chart.columns.find((each) => each.month === shown)
  const rows = column?.shares
    ? props.shown
        .map((each) => ({
          month: shown,
          key: each.key,
          label: each.label,
          share: column.shares![each.index] ?? 0,
        }))
        .sort((a, b) => b.share - a.share)
    : []
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        aria-live="polite"
        className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-border px-3 py-2 text-[12px]"
      >
        <b className="text-[13px]">{label(shown)}</b>
        {rows.length === 0 ? (
          <span className="text-muted-foreground">
            {NO_DATA}: KSEI's report has no row for this month.
          </span>
        ) : (
          rows.map((row) => (
            <span key={row.key} className="flex items-center whitespace-nowrap">
              <Swatch
                color={SERIES_COLOR[row.key as keyof typeof SERIES_COLOR]}
              />
              {row.label} <b className="num ml-1">{pct(row.share)}</b>
            </span>
          ))
        )}
        <span className="text-muted-foreground">
          · % of {Effect.runSync(ofWhat(props.origin))}
          {month === undefined && " · newest month"}
        </span>
      </div>
      <div className="flex min-w-0" role="group" aria-label="Holding chart">
        <Rail axisMax={props.chart.axisMax} />
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto pb-1">
          <Chart
            definition={definition}
            ariaLabel="Holding composition by month. Arrow keys step through the months; the readout above shows the focused one."
            width={widthOf(props.chart.columns.length)}
            height={HEIGHT + X_AXIS}
            className="text-muted-foreground"
            onFocusGroupChange={(points) => {
              const next = points[0]?.xValue
              if (next !== undefined) setMonth(String(next))
              follow(scroller, points)
            }}
          />
        </div>
      </div>
    </div>
  )
}
