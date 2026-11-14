// How chart 1 and chart 2 move together (spec apinrdw/kumora#263, "Own
// zoom", "Pan sync" and "Window band"). The page makes one pair per selected
// code; each chart canvas attaches its chart once drawn, and the page calls
// `jumpTo` when a sweep is picked, in the log or on chart 1. Both charts draw
// the same minutes (lib/chart-nav.ts `chartMinutes`), so a logical bar index
// is the same minute on each.
//
// - Chart 2 opens and refits at exactly 10 whole minutes: on every jump and
//   when its width changes, around its current middle.
// - A pan gesture on either chart (a drag, the coast after a touch, a
//   horizontal wheel) moves the other by the same bars; a zoom never
//   propagates, and neither does a range change no gesture made. The pair
//   holds the two ranges a fixed number of bars apart through a gesture,
//   because range events arrive a frame late.
// - The crosshair follows the pointer's time on the other chart.
// - Chart 1 shades chart 2's minutes, and a click on it moves chart 2 there.
//
// The module imports Lightweight Charts' types only, so the page can make a
// pair on the server.
import { Effect } from "effect"
import type {
  IChartApi,
  ISeriesApi,
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
  // Chart 2 to the 10 minutes around `minute` (a picked sweep's).
  readonly jumpTo: (minute: number) => void
  // Chart 2 to the 10 minutes ending at the last one at or before `minute`:
  // its opening window, and a recorded day's cursor.
  readonly showUpTo: (minute: number) => void
}

type Fit =
  | { readonly _tag: "Around"; readonly minute: number }
  | { readonly _tag: "UpTo"; readonly minute: number }
  | { readonly _tag: "Middle"; readonly logical: number }

// Decision: a touch pan goes on for 3 s after the last finger lifts.
// Lightweight Charts 5.2.1 coasts the chart on (kinetic scroll) for at most
// 2.8 s, from its top speed of 7 px/ms, its damping of 0.997 a ms and its
// narrowest bar of 0.5 px, and tells no one when it stops.
const COAST_MS = 3_000

export const makeChartPair = () =>
  Effect.sync((): ChartPair => {
    let candles: PairedChart | undefined
    let footprint:
      | (PairedChart & { readonly minutes: () => ReadonlyArray<number> })
      | undefined
    let band: Effect.Success<ReturnType<typeof makeWindowBand>> | undefined
    // The chart a gesture is panning; none after a fit, so a refit under a
    // held pointer stays chart 2's own.
    // Decision: only a pan gesture moves the other chart, not every range
    // change on the chart the pointer last touched (spec apinrdw/kumora#263,
    // "Pan sync"). Lightweight Charts also moves a range, its width kept,
    // with no gesture: a new minute scrolls it on, a redraw shifts it, a
    // picked sweep centres chart 1. See apinrdw/kumora#279.
    let panning: IChartApi | undefined
    // When the coast after a touch on it is over.
    let coastEnds: number | undefined
    // How many bars the other chart's range starts after the panning one's:
    // the gesture holds it, so a new minute that scrolls both charts
    // mid-gesture moves the other chart once.
    let apart: number | undefined
    // Each chart's last reported range.
    const reported = new Map<IChartApi, BarRange>()
    // The range this pair last set on each chart. Until the chart reports
    // it, that is where the chart is going: a frame late, or never when the
    // chart stops short at the end of its bars. A gesture on the chart
    // itself forgets it.
    const sentTo = new Map<IChartApi, BarRange>()
    // The same range, kept through such a gesture: its report is the pair's
    // own move, never a pan, whoever pans by then.
    const echoes = new Map<IChartApi, BarRange>()
    const move = (chart: IChartApi, range: BarRange) => {
      sentTo.set(chart, range)
      echoes.set(chart, range)
      chart.timeScale().setVisibleLogicalRange(range)
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
        panning = undefined
        move(side.chart, range)
      })
    }

    // Follows `side`'s range changes: marks them on its element, moves the
    // band, and through a pan gesture on it, moves the other chart by as
    // many bars.
    const follow = (
      side: PairedChart,
      other: () => PairedChart | undefined
    ) => {
      const { chart, element } = side
      // Where the other chart is, or is going.
      const there = () => {
        const follower = other()
        return follower === undefined
          ? null
          : (sentTo.get(follower.chart) ??
              follower.chart.timeScale().getVisibleLogicalRange())
      }
      // A gesture starts on this chart. Reading its range first reports a
      // change not yet reported, while no gesture is open: it is no pan.
      const begin = () => {
        panning = undefined
        const here = chart.timeScale().getVisibleLogicalRange()
        const target = there()
        panning = chart
        coastEnds = undefined
        sentTo.delete(chart)
        apart =
          here === null || target === null ? undefined : target.from - here.from
      }
      // The gesture is over. Reading the range reports its last step first,
      // which Lightweight Charts would report a frame late.
      const end = () => {
        if (panning !== chart) return
        chart.timeScale().getVisibleLogicalRange()
        panning = undefined
      }
      // Lightweight Charts drags with the main button only, and a right
      // click may never report its button coming up.
      const press = (event: PointerEvent) => {
        if (event.button === 0) begin()
      }
      // A mouse's button comes up wherever the pointer is by then.
      const release = (event: PointerEvent) => {
        if (event.pointerType !== "touch") end()
      }
      const lift = (event: TouchEvent) => {
        if (panning !== chart || event.touches.length > 0) return
        chart.timeScale().getVisibleLogicalRange()
        coastEnds = performance.now() + COAST_MS
      }
      // A horizontal wheel scrolls the chart at once, between the capturing
      // listener and the bubbling one. Any other wheel zooms in Lightweight
      // Charts 5.2.1: it reports a width change, then a shift that keeps the
      // bar under the pointer, and neither is a pan.
      const wheel = (event: WheelEvent) =>
        event.deltaX !== 0 && event.deltaY === 0 ? begin() : end()
      const heard = new AbortController()
      // In the capture phase: the chart's own handlers, below the element,
      // move it before a bubbling listener would hear the gesture.
      const capturing = { passive: true, capture: true, signal: heard.signal }
      element.addEventListener("pointerdown", press, capturing)
      element.addEventListener("touchstart", begin, capturing)
      element.addEventListener("touchend", lift, capturing)
      element.addEventListener("touchcancel", lift, capturing)
      element.addEventListener("wheel", wheel, capturing)
      element.addEventListener("wheel", end, {
        passive: true,
        signal: heard.signal,
      })
      window.addEventListener("pointerup", release, capturing)
      window.addEventListener("pointercancel", release, capturing)
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
        ) {
          echoes.delete(chart)
          sentTo.delete(chart)
          // A gesture that began before this move was painted measured from
          // the range before it.
          if (panning === chart) apart = undefined
          return
        }
        if (coastEnds !== undefined && performance.now() > coastEnds)
          panning = undefined
        if (panning !== chart || previous === undefined) return
        const follower = other()
        const target = there()
        if (follower === undefined || target === null) return
        // A zoom: the gesture goes on from as far apart as it leaves them.
        if (Effect.runSync(panShift(previous, range)) === undefined)
          return void (apart = target.from - range.from)
        apart ??= target.from - previous.from
        const from = range.from + apart
        move(follower.chart, { from, to: from + target.to - target.from })
      }
      // Decision: the pair reads a chart's range when the chart attaches.
      // Lightweight Charts 5.2.1 reports a range only when it changes, and a
      // chart whose data was in the store when it mounted has its range
      // before the pair subscribes: with no report to measure from, the
      // first step of its first pan would not move the other chart.
      moved(chart.timeScale().getVisibleLogicalRange())
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
        heard.abort()
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(moved)
        chart.unsubscribeCrosshairMove(crosshair)
        reported.delete(chart)
        sentTo.delete(chart)
        echoes.delete(chart)
        if (panning === chart) panning = undefined
      }
    }

    return {
      attachCandles: (side, colors) => {
        candles = side
        const shade = Effect.runSync(
          makeWindowBand(
            () => {
              const shown = footprint?.chart
                .timeScale()
                .getVisibleLogicalRange()
              return shown ?? null
            },
            colors.shade,
            colors.edge
          )
        )
        band = shade
        side.series.attachPrimitive(shade)
        // A click on a minute moves chart 2 there. A click on a drawn object,
        // a sweep bubble, is the object's: selecting the sweep moves chart 2.
        const click = (parameter: MouseEventParams<Time>) => {
          if (
            parameter.logical !== undefined &&
            parameter.hoveredObjectId === undefined
          )
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
