import { useEffect, useRef, useState } from "react"
import type {
  CandlestickData,
  HistogramData,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  LineData,
  SeriesMarker,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts"

import type { MinuteCandle, ProfileLevel, Sweep, Wall } from "@/domain/trade"
import { WIB_MS } from "@/relay/trading-day"

import { ChartLayer, paintSessionMarks, paintProfile } from "./chart-layers"
import type { SessionMarks, Profile } from "./chart-layers"
import { fitKey, volumeBars } from "./chart-slots"
import type { ChartSlots } from "./chart-slots"
import { chartMarkers, netPoints } from "./live-model"
import type { CandlePeriod } from "./live-model"
import { profileRows } from "./profile-rows"

/** The library draws times as UTC, so WIB is shifted in. */
const chartTime = (iso: string) =>
  ((Date.parse(iso) + WIB_MS) / 1000) as UTCTimestamp

const NET_PANE = 1
const NET_PANE_HEIGHT = 110
/** The volume bars keep to the bottom fifth of the candles' pane. */
const VOLUME_TOP = 0.8
/** About 4 px a row on the candles' pane; past it, the profile buckets its prices. */
const PROFILE_ROWS = 100

type Tokens = {
  up: string
  down: string
  grid: string
  text: string
  line: string
  neutral: string
  gap: string
  divider: string
}

const readTokens = (el: Element): Tokens => {
  const css = getComputedStyle(el)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return {
    up: token("--semantic-up"),
    down: token("--semantic-down"),
    grid: token("--border-subtle"),
    text: token("--text-muted"),
    line: token("--text-primary"),
    neutral: token("--semantic-neutral"),
    gap: token("--semantic-warning"),
    divider: token("--border-strong"),
  }
}

const sessionMarkColors = (tokens: Tokens) => ({
  gapColor: tokens.gap,
  dividerColor: tokens.divider,
})

const profileColors = (tokens: Tokens) => ({
  buyColor: tokens.up,
  sellColor: tokens.down,
  unspecifiedColor: tokens.neutral,
})

type Drawn = {
  chart: IChartApi
  tokens: Tokens
  candles: ISeriesApi<"Candlestick">
  volume: ISeriesApi<"Histogram">
  net: ISeriesApi<"Histogram">
  cumulative: ISeriesApi<"Line">
  markers: ISeriesMarkersPluginApi<Time>
  sessionMarks: ChartLayer<SessionMarks>
  profile: ChartLayer<Profile>
}

type Props = {
  slots: ChartSlots
  profile: ReadonlyArray<ProfileLevel>
  sweeps: ReadonlyArray<Sweep>
  walls: ReadonlyArray<Wall>
  period: CandlePeriod
}

const draw = (
  drawn: Drawn,
  { slots: { slots, secondSession }, profile, sweeps, walls, period }: Props
) => {
  const { candles, volume, net, cumulative, markers, tokens } = drawn
  const shown = slots.flatMap(({ candle }): Array<MinuteCandle> =>
    candle ? [candle] : []
  )
  // A slot with no candle is whitespace, so a quiet period keeps its place.
  candles.setData(
    slots.map(({ at, candle }): CandlestickData<Time> | WhitespaceData<Time> =>
      candle
        ? {
            time: chartTime(at),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          }
        : { time: chartTime(at) }
    )
  )
  drawn.sessionMarks.set({
    gaps: slots.filter((s) => s.gap).map((s) => chartTime(s.at)),
    divider: secondSession === null ? null : chartTime(secondSession),
    ...sessionMarkColors(tokens),
  })
  drawn.profile.set({
    rows: profileRows(profile, PROFILE_ROWS),
    ...profileColors(tokens),
  })
  volume.setData(
    volumeBars(slots).map(({ at, lots, tone }): HistogramData<Time> => ({
      time: chartTime(at),
      value: lots,
      color: tone === "quiet" ? "transparent" : tokens[tone],
    }))
  )
  const points = netPoints(shown, sweeps, period.ms)
  net.setData(
    points.map(({ at, net: value }): HistogramData<Time> => ({
      time: chartTime(at),
      value,
      color: value >= 0 ? tokens.up : tokens.down,
    }))
  )
  cumulative.setData(
    points.map(({ at, cumulative: value }): LineData<Time> => ({
      time: chartTime(at),
      value,
    }))
  )
  markers.setMarkers(
    chartMarkers(shown, sweeps, walls, period.ms).map(
      ({ at, tone, text }): SeriesMarker<Time> => ({
        time: chartTime(at),
        position: tone === "up" ? "belowBar" : "aboveBar",
        shape: tone === "up" ? "arrowUp" : "arrowDown",
        color: tone === "up" ? tokens.up : tokens.down,
        text,
      })
    )
  )
}

const createDrawn = async (el: HTMLElement): Promise<Drawn> => {
  const lib = await import("lightweight-charts")
  const tokens = readTokens(el)
  const chart = lib.createChart(el, {
    autoSize: true,
    layout: {
      background: { color: "transparent" },
      textColor: tokens.text,
      panes: { separatorColor: tokens.grid },
    },
    grid: {
      vertLines: { color: tokens.grid },
      horzLines: { color: tokens.grid },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      // The volume bar of a new slot replaces the candles' whitespace in it.
      allowShiftVisibleRangeOnWhitespaceReplacement: true,
    },
  })
  const candles = chart.addSeries(lib.CandlestickSeries, {
    upColor: tokens.up,
    downColor: tokens.down,
    wickUpColor: tokens.up,
    wickDownColor: tokens.down,
    borderVisible: false,
  })
  const volume = chart.addSeries(lib.HistogramSeries, {
    priceScaleId: "volume",
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  })
  volume
    .priceScale()
    .applyOptions({ scaleMargins: { top: VOLUME_TOP, bottom: 0 } })
  const net = chart.addSeries(
    lib.HistogramSeries,
    {
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    },
    NET_PANE
  )
  const cumulative = chart.addSeries(
    lib.LineSeries,
    {
      color: tokens.line,
      lineWidth: 2,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
    },
    NET_PANE
  )
  chart.panes()[NET_PANE]?.setHeight(NET_PANE_HEIGHT)
  const sessionMarks = new ChartLayer<SessionMarks>(
    {
      gaps: [],
      divider: null,
      ...sessionMarkColors(tokens),
    },
    paintSessionMarks
  )
  const profile = new ChartLayer<Profile>(
    {
      rows: [],
      ...profileColors(tokens),
    },
    paintProfile
  )
  candles.attachPrimitive(sessionMarks)
  candles.attachPrimitive(profile)
  return {
    sessionMarks,
    profile,
    chart,
    tokens,
    candles,
    volume,
    net,
    cumulative,
    markers: lib.createSeriesMarkers(candles, []),
  }
}

/**
 * Candles with sweep and wall markers and the session's volume profile, over a pane of net sweep
 * lots. Source gaps are shaded. Client only: the library needs a canvas.
 */
export function LiveChart({ slots, profile, sweeps, walls, period }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const fitted = useRef<string | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let gone = false
    let made: Drawn | null = null
    void createDrawn(el).then((result) => {
      if (gone) {
        result.chart.remove()
        return
      }
      made = result
      setDrawn(result)
    })
    return () => {
      gone = true
      made?.chart.remove()
    }
  }, [])

  useEffect(() => {
    if (!drawn) return
    draw(drawn, { slots, profile, sweeps, walls, period })
    const fit = fitKey(period, slots)
    if (fitted.current === fit) return
    fitted.current = fit
    drawn.chart.timeScale().fitContent()
  }, [drawn, slots, profile, sweeps, walls, period])

  return (
    <div
      ref={host}
      role="img"
      aria-label={`${period.label} candles with sweep and wall markers and the session's volume profile, over net sweep lots. Shaded periods had no source. The feed lists the same events.`}
      className="h-[520px] min-w-0"
    />
  )
}
