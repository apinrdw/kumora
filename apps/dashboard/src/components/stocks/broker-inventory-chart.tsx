// The Broker inventory tab's chart (spec apinrdw/kumora#437, "Dashboard: the
// stock page"; prototype variant B): each plotted broker's running net, one
// point per day of the axis, labelled at its end, over a zero line. A day
// that isn't built is a shaded "incomplete" band the lines cross dotted.
//
// An SVG of layers over one frame: the frame maps day indexes and nets to
// pixels, and each layer draws from it alone.
import type { BrokerCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { compact, dayLabel, sign } from "@/lib/format"

// One plotted broker's line: its running net per axis day.
export interface InventoryLine {
  readonly broker: BrokerCode
  readonly color: string
  readonly values: ReadonlyArray<number>
}

// The SVG's height, and the margins around the plot: net labels on the
// left, the lines' broker codes on the right, day labels below.
const HEIGHT = 340
const LEFT = 64
const RIGHT = 40
const TOP = 16
const BOTTOM = 24
// Until the container is measured, as on the server.
const DEFAULT_WIDTH = 900
const NET_TICKS = 5
const DAY_TICKS = 8
// A band's "incomplete" label runs across it from this many px wide, and
// down it from a day's 12 px; a narrower band has none.
const BAND_LABEL = 56
const BAND_LABEL_DOWN = 12
// End labels this close apart are nudged apart.
const LABEL_GAP = 11

// The pixels one chart lays its layers out in.
interface ChartFrame {
  readonly width: number
  readonly height: number
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  // One day's width on the axis.
  readonly step: number
  readonly x: (day: number) => number
  readonly y: (net: number) => number
  readonly netTicks: ReadonlyArray<number>
}

// A round step near span / count: 1, 2 or 5 times a power of ten.
const niceStep = (span: number, count: number) =>
  Effect.sync(() => {
    const raw = span / count
    const power = 10 ** Math.floor(Math.log10(raw))
    const unit = raw / power
    return power * (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10)
  })

const chartFrame = Effect.fnUntraced(function* (
  width: number,
  days: number,
  lines: ReadonlyArray<InventoryLine>
) {
  let low = 0
  let high = 0
  for (const { values } of lines)
    for (const value of values) {
      low = Math.min(low, value)
      high = Math.max(high, value)
    }
  const tick = high === low ? 1 : yield* niceStep(high - low, NET_TICKS)
  const bottomNet = Math.floor(low / tick) * tick
  const topNet = Math.ceil(high / tick) * tick || tick
  const netTicks: Array<number> = []
  for (let net = bottomNet; net <= topNet + tick / 2; net += tick)
    netTicks.push(net)
  const right = width - RIGHT
  const bottom = HEIGHT - BOTTOM
  const step = (right - LEFT) / Math.max(1, days)
  return {
    width,
    height: HEIGHT,
    left: LEFT,
    right,
    top: TOP,
    bottom,
    step,
    // A day sits mid-step, so a band is its whole step.
    x: (day: number) => LEFT + step * (day + 0.5),
    y: (net: number) =>
      TOP + ((topNet - net) * (bottom - TOP)) / (topNet - bottomNet),
    netTicks,
  } satisfies ChartFrame
})

/** −1.2 K, +350 */
const netLabel = Effect.fnUntraced(function* (net: number) {
  return (yield* sign(net)) + (yield* compact(net))
})

/** Nov 6 */
const shortDay = (day: WibDate) =>
  Effect.map(dayLabel(day), (label) => label.slice(label.indexOf(" ") + 1))

// Runs of consecutive unbuilt days, as [first, last] day indexes.
const gapRuns = Effect.fnUntraced(function* (built: ReadonlyArray<boolean>) {
  const runs: Array<readonly [number, number]> = []
  built.forEach((isBuilt, day) => {
    if (isBuilt) return
    const last = runs.at(-1)
    if (last !== undefined && last[1] === day - 1)
      runs[runs.length - 1] = [last[0], day]
    else runs.push([day, day])
  })
  return runs
})

// Each line's end label y, nudged apart where two would overlap, in the
// lines' order.
const labelYs = Effect.fnUntraced(function* (ends: ReadonlyArray<number>) {
  const order = ends.map((y, line) => ({ y, line })).sort((a, b) => a.y - b.y)
  for (let at = 1; at < order.length; at++) {
    const above = order[at - 1]
    const here = order[at]
    if (above && here && here.y - above.y < LABEL_GAP)
      here.y = above.y + LABEL_GAP
  }
  const ys: Array<number> = []
  for (const { y, line } of order) ys[line] = y
  return ys
})

// The container's width, measured.
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, Math.round(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function GapBands({
  frame,
  built,
}: {
  frame: ChartFrame
  built: ReadonlyArray<boolean>
}) {
  const runs = useMemo(() => Effect.runSync(gapRuns(built)), [built])
  return (
    <g>
      {runs.map(([first, last]) => {
        const x = frame.x(first) - frame.step / 2
        const width = frame.step * (last - first + 1)
        return (
          <g key={first} data-gap="">
            <rect
              x={x}
              y={frame.top}
              width={width}
              height={frame.bottom - frame.top}
              className="fill-muted-foreground/15"
            />
            <title>incomplete</title>
            {width >= BAND_LABEL ? (
              <text
                x={x + width / 2}
                y={frame.top + 10}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                incomplete
              </text>
            ) : width >= BAND_LABEL_DOWN ? (
              <text
                transform={`translate(${x + width / 2 + 3},${frame.top + 6}) rotate(90)`}
                className="fill-muted-foreground text-[10px]"
              >
                incomplete
              </text>
            ) : null}
          </g>
        )
      })}
    </g>
  )
}

function NetAxis({ frame }: { frame: ChartFrame }) {
  return (
    <g>
      {frame.netTicks.map((net) => (
        <g key={net}>
          <line
            x1={frame.left}
            x2={frame.right}
            y1={frame.y(net)}
            y2={frame.y(net)}
            className={net === 0 ? "stroke-muted-foreground" : "stroke-grid"}
            data-zero={net === 0 ? "" : undefined}
          />
          <text
            x={frame.left - 6}
            y={frame.y(net) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[10px] tabular-nums"
          >
            {Effect.runSync(netLabel(net))}
          </text>
        </g>
      ))}
    </g>
  )
}

function DayAxis({
  frame,
  days,
}: {
  frame: ChartFrame
  days: ReadonlyArray<WibDate>
}) {
  const every = Math.max(1, Math.ceil(days.length / DAY_TICKS))
  return (
    <g>
      {days.map((day, index) =>
        index % every === 0 ? (
          <text
            key={day}
            x={frame.x(index)}
            y={frame.height - 8}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {Effect.runSync(shortDay(day))}
          </text>
        ) : null
      )}
    </g>
  )
}

function BrokerLines({
  frame,
  built,
  lines,
}: {
  frame: ChartFrame
  built: ReadonlyArray<boolean>
  lines: ReadonlyArray<InventoryLine>
}) {
  const ends = useMemo(
    () =>
      Effect.runSync(
        labelYs(lines.map(({ values }) => frame.y(values.at(-1) ?? 0)))
      ),
    [frame, lines]
  )
  return (
    <g>
      {lines.map(({ broker, color, values }, line) => {
        let solid = ""
        let dotted = ""
        for (let day = 1; day < values.length; day++) {
          const segment = `M${frame.x(day - 1)},${frame.y(values[day - 1] ?? 0)}L${frame.x(day)},${frame.y(values[day] ?? 0)}`
          if (built[day] && built[day - 1]) solid += segment
          else dotted += segment
        }
        return (
          <g key={broker} data-broker={broker} style={{ color }}>
            <path
              d={solid}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
            />
            <path
              d={dotted}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              strokeDasharray="2 3"
              opacity={0.7}
            />
            <text
              x={frame.right + 4}
              y={(ends[line] ?? 0) + 3}
              fill="currentColor"
              className="text-[10px] font-semibold"
            >
              {broker}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export function BrokerInventoryChart({
  days,
  built,
  lines,
}: {
  days: ReadonlyArray<WibDate>
  built: ReadonlyArray<boolean>
  lines: ReadonlyArray<InventoryLine>
}) {
  const [ref, width] = useWidth()
  const frame = useMemo(
    () => Effect.runSync(chartFrame(width, days.length, lines)),
    [width, days.length, lines]
  )
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg
        width={frame.width}
        height={frame.height}
        role="img"
        aria-label="Broker inventory chart"
        className="block"
      >
        <GapBands frame={frame} built={built} />
        <NetAxis frame={frame} />
        <DayAxis frame={frame} days={days} />
        <BrokerLines frame={frame} built={built} lines={lines} />
      </svg>
    </div>
  )
}
