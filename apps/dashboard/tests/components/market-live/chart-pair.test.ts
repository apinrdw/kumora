// @vitest-environment happy-dom
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type {
  IChartApi,
  ISeriesApi,
  SeriesType,
  Time,
} from "lightweight-charts"

import { makeChartPair } from "@/components/market-live/chart-pair"
import type { BarRange } from "@/lib/chart-nav"

// A chart as the pair sees one of Lightweight Charts 5.2.1's: it tells its
// range only to the handlers subscribed when the range changes, so a chart
// that drew before the pair subscribed stays silent until it next moves.
const chartShowing = (opening: BarRange) => {
  let shown = opening
  const handlers = new Set<(range: BarRange) => void>()
  const show = (range: BarRange) => {
    shown = range
    for (const handler of handlers) handler(range)
  }
  const element = document.createElement("div")
  const chart = {
    timeScale: () => ({
      getVisibleLogicalRange: () => shown,
      setVisibleLogicalRange: show,
      subscribeVisibleLogicalRangeChange: (
        handler: (range: BarRange) => void
      ) => handlers.add(handler),
      unsubscribeVisibleLogicalRangeChange: (
        handler: (range: BarRange) => void
      ) => handlers.delete(handler),
    }),
    subscribeCrosshairMove() {},
    unsubscribeCrosshairMove() {},
    subscribeClick() {},
    unsubscribeClick() {},
  }
  const series = { attachPrimitive() {}, detachPrimitive() {} }
  return {
    side: {
      chart: chart as unknown as IChartApi,
      series: series as unknown as ISeriesApi<SeriesType, Time>,
      element,
    },
    shown: () => shown,
    // The pointer goes down on the chart, then drags it by `bars`.
    drag: (bars: number) => {
      element.dispatchEvent(new Event("pointerdown"))
      show({ from: shown.from + bars, to: shown.to + bars })
    },
    // The chart's range changes with no pointer on it: its data arrived.
    show,
  }
}

const COLORS = { shade: "#0001", edge: "#000" }

// Both charts attached to one pair.
const pairOf = (
  candles: ReturnType<typeof chartShowing>,
  footprint: ReturnType<typeof chartShowing>
) => {
  const pair = Effect.runSync(makeChartPair())
  pair.attachCandles(candles.side, COLORS)
  pair.attachFootprint({ ...footprint.side, minutes: () => [] })
}

describe("a pan on chart 1", () => {
  it("moves chart 2 by the same bars when chart 1's data arrived after it attached", () => {
    const candles = chartShowing({ from: 0, to: 0 })
    const footprint = chartShowing({ from: 52, to: 61 })
    pairOf(candles, footprint)
    candles.show({ from: -64.67, to: 65 })

    candles.drag(-5)

    expect(footprint.shown()).toEqual({ from: 47, to: 56 })
  })

  it("moves chart 2 by the same bars from the first bar dragged when chart 1 was drawn before it attached", () => {
    const candles = chartShowing({ from: -64.67, to: 65 })
    const footprint = chartShowing({ from: 52, to: 61 })
    pairOf(candles, footprint)

    candles.drag(-5)

    expect(footprint.shown()).toEqual({ from: 47, to: 56 })
  })
})

describe("a chart drawn before it attached", () => {
  // The e2e specs measure a pan from these marks.
  it("has its range marked on its element", () => {
    const candles = chartShowing({ from: -64.67, to: 65 })
    pairOf(candles, chartShowing({ from: 52, to: 61 }))

    expect(candles.side.element.dataset).toMatchObject({
      from: "-64.67",
      to: "65.00",
    })
  })
})
