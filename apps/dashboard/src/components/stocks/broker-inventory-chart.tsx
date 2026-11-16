// The Broker inventory tab's chart (spec apinrdw/kumora#437, "Dashboard: the
// stock page"; prototype variant B): each plotted broker's running net, one
// point per day of the axis, labelled at its end, over a zero line. A day
// that isn't built is a shaded "incomplete" band the lines cross dotted.
// Behind the lines, the code's daily candles on a right-hand price axis, and
// its daily volume in a strip underneath (apinrdw/kumora#421, "Amended
// 2026-11-16"). A candle's body opens that recorded day in Market Live.
//
// An SVG of layers over one frame: the frame maps day indexes, nets, prices
// and volumes to pixels, and each layer draws from it alone.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { compact, dayLabel, price, sign } from "@/lib/format"
import { labelPrices } from "@/lib/price-axis"
import type { CandleColumns } from "@/server/broker-totals/inventory"

// One plotted broker's line: its running net per axis day.
export interface InventoryLine {
  readonly broker: BrokerCode
  readonly color: string
  readonly values: ReadonlyArray<number>
}

// The SVG's height, and the margins around the plot: net labels on the
// left, the lines' broker codes then prices on the right, day labels below.
const HEIGHT = 420
const LEFT = 64
const RIGHT = 84
const TOP = 16
const BOTTOM = 24
// The volume strip's height under the plot, and the space above it.
const VOLUME = 64
const VOLUME_GAP = 10
// `labelPrices` keeps labels 13 px apart; the price axis asks it for a
// pane this many times shorter, so its labels sit about 52 px apart.
const PRICE_LABEL_SPREAD = 4
// The price range's margin above and below, as a share of it, so no
// candle touches the plot's edge; a flat range gets 1% of its price.
const PRICE_PAD = 0.06
// A candle body's and volume bar's share of its day's step, up to a most
// width, and a body's least height.
const BODY = 0.6
const BODY_MAX = 12
const BODY_MIN = 2
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
  // A candle body's and a volume bar's width, centred on `x`.
  readonly bar: number
  readonly y: (net: number) => number
  readonly netTicks: ReadonlyArray<number>
  // The price axis, over the same plot as the nets.
  readonly priceY: (price: number) => number
  readonly priceTicks: ReadonlyArray<number>
  // The volume strip under the plot; a bar's height for a volume.
  readonly volumeTop: number
  readonly volumeBottom: number
  readonly volumeHeight: (volume: number) => number
  readonly maxVolume: number
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
  lines: ReadonlyArray<InventoryLine>,
  candles: CandleColumns
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
  const volumeBottom = HEIGHT - BOTTOM
  const volumeTop = volumeBottom - VOLUME
  const bottom = volumeTop - VOLUME_GAP
  const step = (right - LEFT) / Math.max(1, days)
  const lowPrice = Math.min(...candles.low)
  const highPrice = Math.max(...candles.high)
  const pad =
    highPrice > lowPrice
      ? (highPrice - lowPrice) * PRICE_PAD
      : Math.max(1, highPrice * 0.01)
  const bottomPrice = lowPrice - pad
  const topPrice = highPrice + pad
  const priceTicks =
    candles.day.length === 0
      ? []
      : yield* labelPrices({
          bottom: bottomPrice,
          top: topPrice,
          height: (bottom - TOP) / PRICE_LABEL_SPREAD,
        })
  const maxVolume = Math.max(0, ...candles.volume)
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
    bar: Math.min(BODY_MAX, Math.max(1, step * BODY)),
    y: (net: number) =>
      TOP + ((topNet - net) * (bottom - TOP)) / (topNet - bottomNet),
    netTicks,
    priceY: (at: number) =>
      TOP + ((topPrice - at) * (bottom - TOP)) / (topPrice - bottomPrice),
    priceTicks,
    volumeTop,
    volumeBottom,
    volumeHeight: (volume: number) =>
      maxVolume > 0 ? (volume / maxVolume) * VOLUME : 0,
    maxVolume,
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
              height={frame.volumeBottom - frame.top}
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

function PriceAxis({ frame }: { frame: ChartFrame }) {
  return (
    <g data-price-axis="">
      {frame.priceTicks.map((at) => (
        <text
          key={at}
          x={frame.width - 4}
          y={frame.priceY(at) + 3}
          textAnchor="end"
          className="fill-muted-foreground text-[10px] tabular-nums"
        >
          {Effect.runSync(price(at))}
        </text>
      ))}
    </g>
  )
}

const rising = (candles: CandleColumns, k: number) =>
  (candles.close[k] ?? 0) >= (candles.open[k] ?? 0)

/** Nov 13 · O 9,150 H 9,400 L 9,100 C 9,350 */
const candleTitle = Effect.fnUntraced(function* (
  day: WibDate,
  candles: CandleColumns,
  k: number
) {
  const figure = (label: string, at: number | undefined) =>
    Effect.map(price(at ?? 0), (text) => `${label} ${text}`)
  const figures = yield* Effect.all([
    figure("O", candles.open[k]),
    figure("H", candles.high[k]),
    figure("L", candles.low[k]),
    figure("C", candles.close[k]),
  ])
  return `${yield* shortDay(day)} · ${figures.join(" ")}`
})

// Each built day's candle, a link to that recorded day in Market Live.
function Candles({
  frame,
  code,
  days,
  candles,
}: {
  frame: ChartFrame
  code: StockCode
  days: ReadonlyArray<WibDate>
  candles: CandleColumns
}) {
  return (
    <g data-candles="" opacity={0.5}>
      {candles.day.map((index, k) => {
        const day = days[index]
        if (day === undefined) return null
        const x = frame.x(index)
        const open = frame.priceY(candles.open[k] ?? 0)
        const close = frame.priceY(candles.close[k] ?? 0)
        const height = Math.max(BODY_MIN, Math.abs(open - close))
        return (
          <g key={day} className={rising(candles, k) ? "text-up" : "text-down"}>
            <line
              x1={x}
              x2={x}
              y1={frame.priceY(candles.high[k] ?? 0)}
              y2={frame.priceY(candles.low[k] ?? 0)}
              stroke="currentColor"
            />
            <Link
              to="/market-live"
              search={{ code, day }}
              aria-label={`Open ${Effect.runSync(shortDay(day))} in Market Live`}
              className="cursor-pointer"
            >
              <rect
                x={x - frame.bar / 2}
                y={(open + close) / 2 - height / 2}
                width={frame.bar}
                height={height}
                fill="currentColor"
              />
              <title>{Effect.runSync(candleTitle(day, candles, k))}</title>
            </Link>
          </g>
        )
      })}
    </g>
  )
}

function VolumeBars({
  frame,
  candles,
}: {
  frame: ChartFrame
  candles: CandleColumns
}) {
  return (
    <g>
      <line
        x1={frame.left}
        x2={frame.right}
        y1={frame.volumeBottom}
        y2={frame.volumeBottom}
        className="stroke-grid"
      />
      {frame.maxVolume > 0 && (
        <text
          x={frame.left - 6}
          y={frame.volumeTop + 8}
          textAnchor="end"
          className="fill-muted-foreground text-[10px] tabular-nums"
        >
          {Effect.runSync(compact(frame.maxVolume))}
        </text>
      )}
      {candles.day.map((index, k) => {
        const height = frame.volumeHeight(candles.volume[k] ?? 0)
        return (
          <rect
            key={index}
            data-volume={index}
            x={frame.x(index) - frame.bar / 2}
            y={frame.volumeBottom - height}
            width={frame.bar}
            height={height}
            className={rising(candles, k) ? "fill-up/40" : "fill-down/40"}
          />
        )
      })}
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
  code,
  days,
  built,
  candles,
  lines,
}: {
  code: StockCode
  days: ReadonlyArray<WibDate>
  built: ReadonlyArray<boolean>
  candles: CandleColumns
  lines: ReadonlyArray<InventoryLine>
}) {
  const [ref, width] = useWidth()
  const frame = useMemo(
    () => Effect.runSync(chartFrame(width, days.length, lines, candles)),
    [width, days.length, lines, candles]
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
        <PriceAxis frame={frame} />
        <Candles frame={frame} code={code} days={days} candles={candles} />
        <VolumeBars frame={frame} candles={candles} />
        <DayAxis frame={frame} days={days} />
        <BrokerLines frame={frame} built={built} lines={lines} />
      </svg>
    </div>
  )
}
