// Lightweight Charts, loaded only in the browser (live-chart.tsx lazy-loads
// this module inside ClientOnly), so the Worker never bundles or runs it.
import {
  marketMomentAt,
  type Candle,
  type Footprint,
  type RelayGap,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import {
  CandlestickSeries,
  LineStyle,
  createChart,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  type MouseEventParams,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { useEffect, useRef, useState } from "react"

import { chartMinutes } from "@/lib/chart-nav"
import { cursorLogical } from "@/lib/replay"

import { attachBookHeatmap } from "./book-heatmap"
import type { CandleChange, CandleStore } from "./candle-store"
import type { ChartPair } from "./chart-pair"
import { CHART_SCALE_WIDTH, crosshairTime, tickMark } from "./chart-time"
import { CursorLine } from "./cursor-line"
import type { HeatmapStore } from "./heatmap-store"
import { useAuctionIndicative } from "./market-conditions"
import { idxPriceAxis } from "./price-axis"
import type { ReplayCursor } from "./replay-cursor"
import { attachSweepBubbles, clickedSweep } from "./sweep-bubbles"
import type { SweepStore } from "./sweep-store"
import { makeVolumePane, volumeBar } from "./volume-pane"

const timeOf = (candle: Candle) =>
  Effect.sync(
    () => (DateTime.toEpochMillis(candle.minute) / 1000) as UTCTimestamp
  )

// The first candle of session 1 and of session 2. The break and the night are
// closed up, so a thin line marks where each session starts.
const sessionStarts = Effect.fnUntraced(function* (
  candles: ReadonlyArray<Candle>
) {
  const starts: Array<UTCTimestamp> = []
  let previous: string | undefined
  for (const candle of candles) {
    const moment = yield* marketMomentAt(candle.minute).pipe(Effect.option)
    const current = Option.getOrUndefined(
      Option.map(moment, (held) => held.phase)
    )
    if (
      (current === "session-1" || current === "session-2") &&
      current !== previous
    )
      starts.push(yield* timeOf(candle))
    previous = current
  }
  return starts
})

// Draws a 1-pixel vertical line at each session start, behind the candles.
class SessionLines implements ISeriesPrimitive<Time> {
  private times: ReadonlyArray<UTCTimestamp> = []
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const timeScale = this.attachedTo?.chart.timeScale()
        if (timeScale === undefined) return
        scope.context.fillStyle = this.color
        const width = Math.max(1, Math.floor(scope.horizontalPixelRatio))
        for (const time of this.times) {
          const x = timeScale.timeToCoordinate(time)
          if (x === null) continue
          scope.context.fillRect(
            Math.round(x * scope.horizontalPixelRatio),
            0,
            width,
            scope.bitmapSize.height
          )
        }
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "bottom", renderer: () => this.renderer },
  ]

  constructor(private readonly color: string) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  setTimes(times: ReadonlyArray<UTCTimestamp>) {
    this.times = times
    this.attachedTo?.requestUpdate()
  }

  paneViews() {
    return this.views
  }
}

// Shades each relay gap's minutes, drawn as whitespace bars since the gap has
// no candles, as not recorded, behind the candles.
class GapShades implements ISeriesPrimitive<Time> {
  private runs: ReadonlyArray<ReadonlyArray<UTCTimestamp>> = []
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const timeScale = this.attachedTo?.chart.timeScale()
        if (timeScale === undefined) return
        const half = timeScale.options().barSpacing / 2
        scope.context.fillStyle = this.color
        for (const run of this.runs) {
          const first = timeScale.timeToCoordinate(run[0]!)
          const last = timeScale.timeToCoordinate(run.at(-1)!)
          if (first === null || last === null) continue
          const left = Math.round((first - half) * scope.horizontalPixelRatio)
          const right = Math.round((last + half) * scope.horizontalPixelRatio)
          scope.context.fillRect(left, 0, right - left, scope.bitmapSize.height)
        }
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "bottom", renderer: () => this.renderer },
  ]

  constructor(private readonly color: string) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  setRuns(runs: ReadonlyArray<ReadonlyArray<UTCTimestamp>>) {
    this.runs = runs
    this.attachedTo?.requestUpdate()
  }

  paneViews() {
    return this.views
  }
}

const MINUTE = 60_000

// The selected code's candles and volume, drawn from the candle store. A
// snapshot redraws with `setData`; deltas go through `update`, at most once an
// animation frame, a closed minute's with the historical flag.
// With `cursor`, a recorded day: candles and volume after the cursor's minute
// are greyed under a cursor line at the cursor's second, and clicking a
// candle picks its minute. Each relay gap in `gaps` is shaded; a gap with no
// end yet is shaded once it ends, or on a recorded day up to the close. It
// moves with chart 2 through `pair`.
export default function ChartCanvas({
  store,
  heatmap,
  sweeps,
  cursor,
  gaps,
  pair,
}: {
  store: CandleStore
  // The selected code's book heatmap, shaded behind the candles.
  heatmap?: HeatmapStore | undefined
  // The selected code's sweeps, drawn as bubbles; none for an index.
  sweeps?: SweepStore | undefined
  cursor?: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
  pair: ChartPair
}) {
  const host = useRef<HTMLDivElement>(null)
  const shownGaps = useRef(gaps)
  const redrawGaps = useRef<() => void>(undefined)
  // The candle series, once drawn: the indicative line goes on it.
  const [series, setSeries] = useState<ReturnType<
    ReturnType<typeof createChart>["addSeries"]
  > | null>(null)
  const indicative = useAuctionIndicative(store.code)?.price

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const up = token("--semantic-up")
    const down = token("--semantic-down")
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: token("--text-muted"),
        fontSize: 11,
      },
      // The price axis draws the horizontal lines, on IDX ticks.
      grid: {
        vertLines: { color: token("--chart-grid") },
        horzLines: { visible: false },
      },
      rightPriceScale: {
        borderColor: token("--border-subtle"),
        minimumWidth: CHART_SCALE_WIDTH,
      },
      timeScale: {
        borderColor: token("--border-subtle"),
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: tickMark,
      },
      localization: { locale: "en-US", timeFormatter: crosshairTime },
      // Decision: on a phone a vertical swipe scrolls the page, not the
      // chart; a horizontal one pans both charts through the pair.
      handleScroll: { vertTouchDrag: false },
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    })
    candles
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } })
    const grey = token("--text-muted")
    const volume = Effect.runSync(
      makeVolumePane(chart, {
        buy: up,
        sell: down,
        none: `${grey}aa`,
        later: `${grey}33`,
      })
    )
    setSeries(candles)
    const axis = Effect.runSync(
      idxPriceAxis(candles, {
        text: token("--text-muted"),
        grid: token("--chart-grid"),
      })
    )
    const sessions = new SessionLines(token("--border-subtle"))
    candles.attachPrimitive(sessions)
    const shades = new GapShades(`${grey}26`)
    candles.attachPrimitive(shades)

    const cursorMinute = () =>
      cursor === undefined
        ? Number.POSITIVE_INFINITY
        : Math.floor(cursor.state().at / MINUTE) * MINUTE
    let shownMinute = cursorMinute()
    const later = (candle: Candle) =>
      DateTime.toEpochMillis(candle.minute) > shownMinute
    const bar = (candle: Candle, time: UTCTimestamp) => ({
      time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(later(candle) && { color: `${grey}55`, wickColor: `${grey}55` }),
    })
    // Each minute's footprint, by its time: its volume bar's sides.
    let footprints = new Map<number, Footprint>()
    const volumeOf = (candle: Candle, time: UTCTimestamp) =>
      Effect.runSync(
        volumeBar(time, candle, footprints.get(time), later(candle))
      )
    const stopHeatmap =
      heatmap &&
      attachBookHeatmap(
        candles,
        heatmap,
        cursor,
        { bid: up, offer: down },
        (slices) => {
          element.dataset.heatmapSlices = String(slices)
        }
      )
    const stopSweeps =
      sweeps === undefined
        ? undefined
        : attachSweepBubbles({
            chart,
            series: candles,
            store: sweeps,
            cursor,
            colors: {
              buy: up,
              sell: down,
              big: token("--semantic-warning"),
              selected: token("--accent-primary"),
            },
            marks: element,
          })
    const marker = new CursorLine(token("--text-primary"), element)
    if (cursor !== undefined) candles.attachPrimitive(marker)

    // The minutes drawn as candles, so a delta can tell a closed minute from
    // a new one, and the series' last bar, candle or gap whitespace: a candle
    // before it can only go in with the historical flag, or by redrawing.
    let drawn = new Set<number>()
    let latest = 0
    // Every bar's time, ascending: the cursor line's place among them.
    let bars: ReadonlyArray<number> = []
    const placeCursor = () => {
      if (cursor !== undefined)
        marker.setLogical(
          Effect.runSync(cursorLogical(bars, cursor.state().at))
        )
    }
    const redraw = () => {
      const all = store.candles()
      footprints = new Map(
        store
          .footprints()
          .map((footprint) => [
            DateTime.toEpochMillis(footprint.minute) / 1000,
            footprint,
          ])
      )
      const times = Effect.runSync(Effect.forEach(all, timeOf))
      drawn = new Set(times)
      const newest = times.at(-1) ?? 0
      // Decision: the chart closes gaps up, so a relay gap's minutes go in
      // as whitespace bars, which give it width to shade.
      const runs = Effect.runSync(
        chartMinutes(
          times.map((time) => time * 1000),
          shownGaps.current,
          cursor === undefined ? newest * 1000 : cursor.day.close
        )
      ).runs.map((run) => run.map((minute) => (minute / 1000) as UTCTimestamp))
      const blank = runs.flat()
      latest = Math.max(newest, blank.at(-1) ?? 0)
      candles.setData(
        [
          ...all.map((candle, index) => bar(candle, times[index]!)),
          ...blank.map((time) => ({ time })),
        ].sort((a, b) => a.time - b.time)
      )
      volume.setData(
        all.map((candle, index) => volumeOf(candle, times[index]!))
      )
      sessions.setTimes(Effect.runSync(sessionStarts(all)))
      shades.setRuns(runs)
      axis.setPrice(all.at(-1)?.close)
      bars = [...drawn, ...blank].sort((a, b) => a - b)
      placeCursor()
    }
    redraw()
    redrawGaps.current = redraw

    // The cursor moved: its line follows; in another minute, grey again
    // from there.
    const stopCursor = cursor?.subscribe(() => {
      const minute = cursorMinute()
      if (minute === shownMinute) return placeCursor()
      shownMinute = minute
      redraw()
    })
    if (cursor !== undefined)
      chart.subscribeClick((parameter: MouseEventParams<Time>) => {
        // A click on a bubble picks its sweep, not the cursor's minute.
        if (Effect.runSync(clickedSweep(parameter)) !== undefined) return
        if (parameter.time !== undefined)
          cursor.pickMinute((parameter.time as UTCTimestamp) * 1000)
      })

    let reset = false
    // Each changed minute's candle, by its time.
    const pending = new Map<UTCTimestamp, Candle>()
    let frame = 0
    const flush = () => {
      frame = 0
      const changed = [...pending].sort(([a], [b]) => a - b)
      pending.clear()
      // A minute the chart has never drawn, before its latest one, can only
      // go in by redrawing.
      if (
        reset ||
        changed.some(([time]) => time < latest && !drawn.has(time))
      ) {
        reset = false
        redraw()
        return
      }
      let starts = false
      for (const [time, candle] of changed) {
        const historical = time < latest
        candles.update(bar(candle, time), historical)
        volume.update(volumeOf(candle, time), historical)
        if (!drawn.has(time)) {
          starts = true
          if (!bars.includes(time)) bars = [...bars, time].sort((a, b) => a - b)
        }
        drawn.add(time)
        latest = Math.max(latest, time)
      }
      if (starts) {
        sessions.setTimes(Effect.runSync(sessionStarts(store.candles())))
        placeCursor()
      }
      axis.setPrice(store.candles().at(-1)?.close)
    }
    const unsubscribe = store.subscribe((change: CandleChange) => {
      if (change._tag === "Reset") reset = true
      else {
        const times = Effect.runSync(Effect.forEach(change.candles, timeOf))
        change.candles.forEach((candle, index) =>
          pending.set(times[index]!, candle)
        )
        for (const footprint of change.footprints)
          footprints.set(
            DateTime.toEpochMillis(footprint.minute) / 1000,
            footprint
          )
      }
      if (frame === 0) frame = requestAnimationFrame(flush)
    })
    const unpair = pair.attachCandles(
      { chart, series: candles, element },
      { shade: `${token("--text-primary")}1a`, edge: token("--accent-primary") }
    )
    return () => {
      unpair()
      redrawGaps.current = undefined
      stopHeatmap?.()
      stopSweeps?.()
      unsubscribe()
      stopCursor?.()
      cancelAnimationFrame(frame)
      setSeries(null)
      chart.remove()
    }
  }, [store, heatmap, sweeps, cursor, pair])

  useEffect(() => {
    shownGaps.current = gaps
    redrawGaps.current?.()
  }, [gaps])

  // During the auctions, the indicative price as a dashed line.
  useEffect(() => {
    const candles = series
    if (candles === null || indicative === undefined) return
    const line = candles.createPriceLine({
      price: indicative,
      color: getComputedStyle(document.documentElement)
        .getPropertyValue("--semantic-info")
        .trim(),
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      title: "Indicative",
    })
    return () => candles.removePriceLine(line)
  }, [indicative, series])

  return (
    <div
      ref={host}
      className="h-[420px] w-full lg:h-auto lg:min-h-[420px] lg:flex-1"
      data-chart="candles"
    />
  )
}
