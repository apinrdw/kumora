// The candle chart's volume pane (spec apinrdw/kumora#263, "Volume pane"): pane
// 1, about a fifth of the chart, one bar a minute split by aggressor side. Buy
// lots sit at the bottom in green, sell lots above them in red, and no-side
// lots (auction matches) cap the bar in grey. A minute after the replay cursor
// is all grey.
import type { Candle, Footprint } from "@workspace/relay"
import { Effect } from "effect"
import {
  HistogramSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts"

// One minute's lots: buy, sell and every lot. A minute with no footprint
// (an index's) counts its candle's volume as no-side.
interface VolumeBar {
  readonly time: UTCTimestamp
  readonly buy: number
  readonly sell: number
  readonly all: number
  readonly later: boolean
}

export const volumeBar = (
  time: UTCTimestamp,
  candle: Candle,
  footprint: Footprint | undefined,
  later: boolean
) =>
  Effect.sync((): VolumeBar => {
    if (footprint === undefined)
      return { time, buy: 0, sell: 0, all: candle.volume, later }
    let buy = 0
    let sell = 0
    let none = 0
    for (const cell of footprint.cells) {
      buy += cell.buy
      sell += cell.sell
      none += cell.none
    }
    return { time, buy, sell, all: buy + sell + none, later }
  })

const PANE = 1

export interface VolumeColors {
  readonly buy: string
  readonly sell: string
  readonly none: string
  readonly later: string
}

// Three overlapping histograms of running totals, each drawn over the one
// before: every lot (grey), then buy + sell (red), then buy (green).
export const makeVolumePane = (chart: IChartApi, colors: VolumeColors) =>
  Effect.sync(() => {
    const addHistogram = (color: string) =>
      chart.addSeries(
        HistogramSeries,
        {
          color,
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
        },
        PANE
      )
    const all = addHistogram(colors.none)
    const sides = addHistogram(colors.sell)
    const buys = addHistogram(colors.buy)
    all.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } })
    chart.panes()[0]?.setStretchFactor(4)
    chart.panes()[PANE]?.setStretchFactor(1)

    const point = (bar: VolumeBar, value: number, color: string) => ({
      time: bar.time,
      value,
      color: bar.later ? colors.later : color,
    })
    const points = (bar: VolumeBar) =>
      [
        point(bar, bar.all, colors.none),
        point(bar, bar.buy + bar.sell, colors.sell),
        point(bar, bar.buy, colors.buy),
      ] as const
    const series = [all, sides, buys] as const

    return {
      setData: (bars: ReadonlyArray<VolumeBar>) => {
        const drawn = bars.map(points)
        series.forEach((histogram, index) =>
          histogram.setData(drawn.map((bar) => bar[index]))
        )
      },
      update: (bar: VolumeBar, historical: boolean) => {
        const drawn = points(bar)
        series.forEach((histogram, index) =>
          histogram.update(drawn[index], historical)
        )
      },
    }
  })
