// Lightweight Charts, loaded only in the browser (live-chart.tsx lazy-loads
// this module inside ClientOnly), so the Worker never bundles or runs it.
import { marketMomentAt, type Candle, type RelayGap } from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  type MouseEventParams,
  type SeriesAttachedParameter,
  type Logical,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { useEffect, useRef, useState } from "react"

import { gapMinutes } from "@/lib/replay"

import type { CandleChange, CandleStore } from "./candle-store"
import { useAuctionIndicative } from "./market-conditions"
import type { ReplayCursor } from "./replay-cursor"

const WIB = "Asia/Jakarta"
const wibClock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: WIB,
})
const wibDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: WIB,
})
const wibYear = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  timeZone: WIB,
})

// The data is in UTC seconds; every label reads WIB, 24-hour. Lightweight
// Charts calls these two back, so they are plain.
const crosshairTime = (time: Time) => {
  const date = new Date((time as UTCTimestamp) * 1000)
  return `${wibDate.format(date)}, ${wibClock.format(date)} WIB`
}
const tickMark = (time: Time, type: TickMarkType) => {
  const date = new Date((time as UTCTimestamp) * 1000)
  return type === TickMarkType.Year
    ? wibYear.format(date)
    : type === TickMarkType.Month || type === TickMarkType.DayOfMonth
      ? wibDate.format(date)
      : wibClock.format(date)
}

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

// Draws the replay cursor as a 2-pixel vertical line at a logical bar
// position, over the candles.
class CursorLine implements ISeriesPrimitive<Time> {
  private logical: number | undefined
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const timeScale = this.attachedTo?.chart.timeScale()
        if (timeScale === undefined || this.logical === undefined) return
        const x = timeScale.logicalToCoordinate(this.logical as Logical)
        if (x === null) return
        scope.context.fillStyle = this.color
        const width = Math.max(2, Math.floor(2 * scope.horizontalPixelRatio))
        scope.context.fillRect(
          Math.round(x * scope.horizontalPixelRatio - width / 2),
          0,
          width,
          scope.bitmapSize.height
        )
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "top", renderer: () => this.renderer },
  ]

  constructor(private readonly color: string) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  setLogical(logical: number | undefined) {
    this.logical = logical
    this.attachedTo?.requestUpdate()
  }

  paneViews() {
    return this.views
  }
}

// Where the cursor's minute sits among the bars drawn (candles and gap
// whitespace, `times` ascending, in seconds), as a logical bar index: on its
// own bar, or half a bar past the latest bar before it.
const cursorLogical = Effect.fnUntraced(function* (
  times: ReadonlyArray<number>,
  minute: number
) {
  const before = times.filter((time) => time * 1000 <= minute)
  const latest = before.at(-1)
  if (latest === undefined) return -0.5
  return before.length - 1 + (latest * 1000 === minute ? 0 : 0.5)
})

const MINUTE = 60_000

// The selected code's candles and volume, drawn from the candle store. A
// snapshot redraws with `setData`; deltas go through `update`, at most once an
// animation frame, a closed minute's with the historical flag.
// With `cursor`, a recorded day: candles after the cursor's minute are
// greyed under a cursor line, and clicking a candle picks its minute. Each
// relay gap in `gaps` is shaded; a gap with no end yet is shaded once it
// ends, or on a recorded day up to the close.
export default function ChartCanvas({
  store,
  cursor,
  gaps,
}: {
  store: CandleStore
  cursor?: ReplayCursor | undefined
  gaps: ReadonlyArray<RelayGap>
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
      grid: {
        vertLines: { color: token("--chart-grid") },
        horzLines: { color: token("--chart-grid") },
      },
      rightPriceScale: { borderColor: token("--border-subtle") },
      timeScale: {
        borderColor: token("--border-subtle"),
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: tickMark,
      },
      localization: { locale: "en-US", timeFormatter: crosshairTime },
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
      .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } })
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    setSeries(candles)
    const sessions = new SessionLines(token("--border-subtle"))
    candles.attachPrimitive(sessions)
    const grey = token("--text-muted")
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
    const volumeBar = (candle: Candle, time: UTCTimestamp) => ({
      time,
      value: candle.volume,
      color: later(candle)
        ? `${grey}33`
        : `${candle.close >= candle.open ? up : down}66`,
    })
    const marker = new CursorLine(token("--text-primary"))
    if (cursor !== undefined) candles.attachPrimitive(marker)

    // The minutes drawn as candles, so a delta can tell a closed minute from
    // a new one, and the series' last bar, candle or gap whitespace: a candle
    // before it can only go in with the historical flag, or by redrawing.
    let drawn = new Set<number>()
    let latest = 0
    const redraw = () => {
      const all = store.candles()
      const times = Effect.runSync(Effect.forEach(all, timeOf))
      drawn = new Set(times)
      const newest = times.at(-1) ?? 0
      // Decision: the chart closes gaps up, so a relay gap's minutes go in
      // as whitespace bars, which give it width to shade.
      const runs = Effect.runSync(
        gapMinutes(
          shownGaps.current,
          cursor === undefined ? newest * 1000 : cursor.day.close
        )
      ).map((run) =>
        run
          .map((minute) => (minute / 1000) as UTCTimestamp)
          .filter((time) => !drawn.has(time))
      )
      const blank = runs.flat()
      latest = Math.max(newest, blank.at(-1) ?? 0)
      candles.setData(
        [
          ...all.map((candle, index) => bar(candle, times[index]!)),
          ...blank.map((time) => ({ time })),
        ].sort((a, b) => a.time - b.time)
      )
      volume.setData(
        all.map((candle, index) => volumeBar(candle, times[index]!))
      )
      sessions.setTimes(Effect.runSync(sessionStarts(all)))
      shades.setRuns(runs.filter((run) => run.length > 0))
      if (cursor !== undefined)
        marker.setLogical(
          Effect.runSync(
            cursorLogical(
              [...drawn, ...blank].sort((a, b) => a - b),
              shownMinute
            )
          )
        )
    }
    redraw()
    redrawGaps.current = redraw

    // The cursor moved to another minute: grey again from there.
    const stopCursor = cursor?.subscribe(() => {
      const minute = cursorMinute()
      if (minute === shownMinute) return
      shownMinute = minute
      redraw()
    })
    if (cursor !== undefined)
      chart.subscribeClick((parameter: MouseEventParams<Time>) => {
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
        volume.update(volumeBar(candle, time), historical)
        if (!drawn.has(time)) starts = true
        drawn.add(time)
        latest = Math.max(latest, time)
      }
      if (starts)
        sessions.setTimes(Effect.runSync(sessionStarts(store.candles())))
    }
    const unsubscribe = store.subscribe((change: CandleChange) => {
      if (change._tag === "Reset") reset = true
      else {
        const times = Effect.runSync(Effect.forEach(change.candles, timeOf))
        change.candles.forEach((candle, index) =>
          pending.set(times[index]!, candle)
        )
      }
      if (frame === 0) frame = requestAnimationFrame(flush)
    })
    return () => {
      redrawGaps.current = undefined
      unsubscribe()
      stopCursor?.()
      cancelAnimationFrame(frame)
      setSeries(null)
      chart.remove()
    }
  }, [store, cursor])

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

  return <div ref={host} className="h-[420px] w-full" data-chart="candles" />
}
