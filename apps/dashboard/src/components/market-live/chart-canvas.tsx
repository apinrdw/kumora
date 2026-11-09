// Lightweight Charts, loaded only in the browser (live-chart.tsx lazy-loads
// this module inside ClientOnly), so the Worker never bundles or runs it.
import { marketMomentAt, type Candle } from "@workspace/relay"
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

import type { CandleChange, CandleStore } from "./candle-store"
import { useAuctionIndicative } from "./market-status"
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

// The data is in UTC seconds; every label reads WIB, 24-hour.
const dateOf = (time: Time) => new Date((time as UTCTimestamp) * 1000)
const crosshairTime = (time: Time) =>
  `${wibDate.format(dateOf(time))}, ${wibClock.format(dateOf(time))} WIB`
const tickMark = (time: Time, type: TickMarkType) =>
  type === TickMarkType.Year
    ? wibYear.format(dateOf(time))
    : type === TickMarkType.Month || type === TickMarkType.DayOfMonth
      ? wibDate.format(dateOf(time))
      : wibClock.format(dateOf(time))

const timeOf = (candle: Candle) =>
  (DateTime.toEpochMillis(candle.minute) / 1000) as UTCTimestamp

// The first candle of session 1 and of session 2. The break and the night are
// closed up, so a thin line marks where each session starts.
const sessionStarts = (candles: ReadonlyArray<Candle>) => {
  const starts: Array<UTCTimestamp> = []
  let previous: string | undefined
  for (const candle of candles) {
    const phase = Effect.runSync(
      marketMomentAt(candle.minute).pipe(Effect.option)
    ).pipe(Option.map((moment) => moment.phase))
    const current = Option.getOrUndefined(phase)
    if (
      (current === "session-1" || current === "session-2") &&
      current !== previous
    )
      starts.push(timeOf(candle))
    previous = current
  }
  return starts
}

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

// Where the cursor's minute sits among the candles, as a logical bar index:
// on its own candle, or half a bar past the latest candle before it.
const cursorLogical = (candles: ReadonlyArray<Candle>, minute: number) => {
  const before = candles.filter(
    (candle) => DateTime.toEpochMillis(candle.minute) <= minute
  )
  const latest = before.at(-1)
  if (latest === undefined) return -0.5
  return (
    before.length -
    1 +
    (DateTime.toEpochMillis(latest.minute) === minute ? 0 : 0.5)
  )
}

const MINUTE = 60_000

// The selected code's candles and volume, drawn from the candle store. A
// snapshot redraws with `setData`; deltas go through `update`, at most once an
// animation frame, a closed minute's with the historical flag.
// With `cursor`, a recorded day: candles after the cursor's minute are
// greyed under a cursor line, and clicking a candle picks its minute.
export default function ChartCanvas({
  store,
  cursor,
}: {
  store: CandleStore
  cursor?: ReplayCursor | undefined
}) {
  const host = useRef<HTMLDivElement>(null)
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
    const cursorMinute = () =>
      cursor === undefined
        ? Number.POSITIVE_INFINITY
        : Math.floor(cursor.state().at / MINUTE) * MINUTE
    let shownMinute = cursorMinute()
    const later = (candle: Candle) =>
      DateTime.toEpochMillis(candle.minute) > shownMinute
    const bar = (candle: Candle) => ({
      time: timeOf(candle),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      ...(later(candle) && { color: `${grey}55`, wickColor: `${grey}55` }),
    })
    const volumeBar = (candle: Candle) => ({
      time: timeOf(candle),
      value: candle.volume,
      color: later(candle)
        ? `${grey}33`
        : `${candle.close >= candle.open ? up : down}66`,
    })
    const marker = new CursorLine(token("--text-primary"))
    if (cursor !== undefined) candles.attachPrimitive(marker)

    // The minutes drawn, so a delta can tell a closed minute from a new one.
    let drawn = new Set<number>()
    let latest = 0
    const redraw = () => {
      const all = store.candles()
      candles.setData(all.map(bar))
      volume.setData(all.map(volumeBar))
      sessions.setTimes(sessionStarts(all))
      drawn = new Set(all.map(timeOf))
      latest = all.length === 0 ? 0 : timeOf(all.at(-1)!)
      if (cursor !== undefined)
        marker.setLogical(cursorLogical(all, shownMinute))
    }
    redraw()

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
    const pending = new Map<number, Candle>()
    let frame = 0
    const flush = () => {
      frame = 0
      const changed = [...pending.values()].sort(
        (a, b) => timeOf(a) - timeOf(b)
      )
      pending.clear()
      // A minute the chart has never drawn, before its latest one, can only
      // go in by redrawing.
      if (
        reset ||
        changed.some(
          (candle) => timeOf(candle) < latest && !drawn.has(timeOf(candle))
        )
      ) {
        reset = false
        redraw()
        return
      }
      let starts = false
      for (const candle of changed) {
        const time = timeOf(candle)
        const historical = time < latest
        candles.update(bar(candle), historical)
        volume.update(volumeBar(candle), historical)
        if (!drawn.has(time)) starts = true
        drawn.add(time)
        latest = Math.max(latest, time)
      }
      if (starts) sessions.setTimes(sessionStarts(store.candles()))
    }
    const unsubscribe = store.subscribe((change: CandleChange) => {
      if (change._tag === "Reset") reset = true
      else
        for (const candle of change.candles) pending.set(timeOf(candle), candle)
      if (frame === 0) frame = requestAnimationFrame(flush)
    })
    return () => {
      unsubscribe()
      stopCursor?.()
      cancelAnimationFrame(frame)
      setSeries(null)
      chart.remove()
    }
  }, [store, cursor])

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
      title: "IEP",
    })
    return () => candles.removePriceLine(line)
  }, [indicative, series])

  return <div ref={host} className="h-[420px] w-full" data-chart="candles" />
}
