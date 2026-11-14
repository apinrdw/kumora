// How chart 1 and chart 2 move together (spec apinrdw/kumora#263, "Own
// zoom", "Pan sync" and "Window band"). The page makes one pair per selected
// code; each chart canvas attaches its chart once drawn, and the sweep log
// calls `jumpTo`. Both charts draw the same minutes (lib/chart-nav.ts
// `chartMinutes`), so a logical bar index is the same minute on each.
//
// - Chart 2 opens and refits at exactly 10 whole minutes: on every jump and
//   when its width changes, around its current middle.
// - A pan (range moved, width kept) on either chart moves the other by the
//   same bars; a zoom never propagates. Only the chart under the pointer
//   leads, and the follower's target is kept here, because range events
//   arrive a frame late.
// - The crosshair follows the pointer's time on the other chart.
// - Chart 1 shades chart 2's minutes, and a click on it moves chart 2 there.
//
// The module imports Lightweight Charts' types only, so the page can make a
// pair on the server.
import { Effect } from "effect"
import type {
  IChartApi,
  ISeriesApi,
  Logical,
  LogicalRange,
  MouseEventParams,
  SeriesType,
  Time,
} from "lightweight-charts"

import { panShift, windowAround, type BarRange } from "@/lib/chart-nav"
import { windowOfLast } from "@/lib/footprint"

import { makeWindowBand } from "./window-band"

// Decision: chart 2 opens on 10 whole minutes, the most whose cells read as
// text beside the sweep log. See spec apinrdw/kumora#263, "Chart 2".
const WINDOW_MINUTES = 10

export interface PairedChart {
  readonly chart: IChartApi
  // The series the crosshair's price is read from and set on.
  readonly series: ISeriesApi<SeriesType, Time>
  readonly element: HTMLElement
}

export interface ChartPair {
  // Chart 1, which shades chart 2's minutes in `colors`. Returns the detach.
  readonly attachCandles: (
    side: PairedChart,
    colors: { readonly shade: string; readonly edge: string }
  ) => () => void
  // Chart 2, with the minutes it draws, ascending (epoch ms).
  readonly attachFootprint: (
    side: PairedChart & { readonly minutes: () => ReadonlyArray<number> }
  ) => () => void
  // Chart 2 to the 10 minutes around `minute` (a sweep log row).
  readonly jumpTo: (minute: number) => void
  // Chart 2 to the 10 minutes ending at the last one at or before `minute`:
  // its opening window, and a recorded day's cursor.
  readonly showUpTo: (minute: number) => void
}

type Fit =
  | { readonly _tag: "Around"; readonly minute: number }
  | { readonly _tag: "UpTo"; readonly minute: number }
  | { readonly _tag: "Middle"; readonly logical: number }

const logicalRange = (range: BarRange): LogicalRange => ({
  from: range.from as Logical,
  to: range.to as Logical,
})

const POINTER_EVENTS = [
  "pointerenter",
  "pointerdown",
  "wheel",
  "touchstart",
] as const

export const makeChartPair = () =>
  Effect.sync((): ChartPair => {
    let candles: PairedChart | undefined
    let footprint:
      | (PairedChart & { readonly minutes: () => ReadonlyArray<number> })
      | undefined
    let band: ReturnType<typeof makeWindowBand> | undefined
    // The chart under the pointer; none after a jump, so the jump's own
    // range change moves only chart 2.
    let leader: IChartApi | undefined
    // Whether the leader's last gesture was a vertical wheel, which zooms in
    // Lightweight Charts 5.2.1: it reports a width change, then a shift
    // that keeps the bar under the pointer, and neither is a pan.
    let zooming = false
    // Each chart's last reported range, and where a follower was sent.
    const reported = new Map<IChartApi, BarRange>()
    const sentTo = new Map<IChartApi, BarRange>()
    // The range this pair last set on each chart: its report, a frame late,
    // is the pair's own move, never a pan, whoever leads by then.
    const echoes = new Map<IChartApi, BarRange>()
    const move = (chart: IChartApi, range: BarRange) => {
      sentTo.set(chart, range)
      echoes.set(chart, range)
      chart.timeScale().setVisibleLogicalRange(logicalRange(range))
    }

    let pending: Fit | undefined
    let frame = 0
    // The bar range a fit shows on chart 2, once it has minutes.
    const rangeOf = (fit: Fit) => {
      if (fit._tag === "Middle")
        return Effect.runSync(windowAround(fit.logical, WINDOW_MINUTES))
      const minutes = footprint?.minutes() ?? []
      let index = -1
      while (index + 1 < minutes.length && minutes[index + 1]! <= fit.minute)
        index++
      if (minutes.length === 0) return undefined
      // Before the first minute: the window opens on it.
      const at = Math.max(0, index)
      return Effect.runSync(
        fit._tag === "Around"
          ? windowAround(at, WINDOW_MINUTES)
          : windowOfLast(at + 1, WINDOW_MINUTES)
      )
    }
    // Fits chart 2 on the next frame, the last fit asked winning. A chart
    // without a width or minutes keeps the fit until it has them: zooming
    // before the chart has a size crushes it to the right edge.
    const fit = (next: Fit) => {
      pending = next
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        const side = footprint
        if (side === undefined || side.element.clientWidth === 0) return
        const range = rangeOf(next)
        if (range === undefined) return
        pending = undefined
        leader = undefined
        move(side.chart, range)
      })
    }

    // Follows `side`'s range changes: marks them on its element, moves the
    // band, and when it leads a pan, moves the other chart by as many bars.
    const follow = (
      side: PairedChart,
      other: () => PairedChart | undefined
    ) => {
      const { chart, element } = side
      const lead = (event: Event) => {
        leader = chart
        zooming = event instanceof WheelEvent && event.deltaY !== 0
        sentTo.delete(chart)
      }
      // In the capture phase: the chart's own handlers, below the element,
      // move it before a bubbling listener would hear the gesture.
      for (const name of POINTER_EVENTS)
        element.addEventListener(name, lead, { passive: true, capture: true })
      const moved = (range: LogicalRange | null) => {
        if (range === null) return
        element.dataset.from = range.from.toFixed(2)
        element.dataset.to = range.to.toFixed(2)
        if (side === footprint) band?.update()
        const previous = reported.get(chart)
        reported.set(chart, range)
        const echo = echoes.get(chart)
        if (
          echo !== undefined &&
          Math.abs(echo.from - range.from) < 1e-3 &&
          Math.abs(echo.to - range.to) < 1e-3
        )
          return void echoes.delete(chart)
        const follower = other()
        if (
          leader !== chart ||
          zooming ||
          previous === undefined ||
          follower === undefined
        )
          return
        const shift = Effect.runSync(panShift(previous, range))
        if (shift === undefined) return
        const from =
          sentTo.get(follower.chart) ??
          follower.chart.timeScale().getVisibleLogicalRange()
        if (from === null) return
        move(follower.chart, { from: from.from + shift, to: from.to + shift })
      }
      chart.timeScale().subscribeVisibleLogicalRangeChange(moved)
      // The crosshair at the pointer's time and price on the other chart.
      const crosshair = (parameter: MouseEventParams<Time>) => {
        const target = other()
        if (target === undefined) return
        const price =
          parameter.point === undefined || (parameter.paneIndex ?? 0) !== 0
            ? null
            : side.series.coordinateToPrice(parameter.point.y)
        if (
          parameter.time === undefined ||
          price === null ||
          target.chart.timeScale().getVisibleLogicalRange() === null
        )
          target.chart.clearCrosshairPosition()
        else
          target.chart.setCrosshairPosition(
            price,
            parameter.time,
            target.series
          )
      }
      chart.subscribeCrosshairMove(crosshair)
      return () => {
        for (const name of POINTER_EVENTS)
          element.removeEventListener(name, lead, { capture: true })
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(moved)
        chart.unsubscribeCrosshairMove(crosshair)
        reported.delete(chart)
        sentTo.delete(chart)
        echoes.delete(chart)
        if (leader === chart) leader = undefined
      }
    }

    return {
      attachCandles: (side, colors) => {
        candles = side
        const shade = makeWindowBand(
          () => {
            const shown = footprint?.chart.timeScale().getVisibleLogicalRange()
            return shown ?? null
          },
          colors.shade,
          colors.edge
        )
        band = shade
        side.series.attachPrimitive(shade)
        // A click on a minute moves chart 2 there.
        const click = (parameter: MouseEventParams<Time>) => {
          if (parameter.logical !== undefined)
            fit({ _tag: "Middle", logical: parameter.logical })
        }
        side.chart.subscribeClick(click)
        const unfollow = follow(side, () => footprint)
        return () => {
          unfollow()
          side.chart.unsubscribeClick(click)
          side.series.detachPrimitive(shade)
          band = undefined
          candles = undefined
        }
      },
      attachFootprint: (side) => {
        footprint = side
        const unfollow = follow(side, () => candles)
        // A new width refits 10 minutes around the middle.
        let width = side.element.clientWidth
        const resized = new ResizeObserver(() => {
          const next = side.element.clientWidth
          if (next === width) return
          width = next
          if (pending !== undefined) return fit(pending)
          const shown =
            sentTo.get(side.chart) ??
            side.chart.timeScale().getVisibleLogicalRange()
          if (shown !== null)
            fit({ _tag: "Middle", logical: (shown.from + shown.to) / 2 })
        })
        resized.observe(side.element)
        if (pending !== undefined) fit(pending)
        band?.update()
        return () => {
          resized.disconnect()
          unfollow()
          cancelAnimationFrame(frame)
          footprint = undefined
        }
      },
      jumpTo: (minute) => fit({ _tag: "Around", minute }),
      showUpTo: (minute) => fit({ _tag: "UpTo", minute }),
    }
  })
