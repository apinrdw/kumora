// What a viewer's own zoom gestures on a chart leave, for the chart to save
// (lib/chart-settings.ts `ChartZoom`), and the price axis held at its saved
// stretch. Loaded only in the browser, by the chart canvases.
import { Effect } from "effect"
import type {
  AutoscaleInfoProvider,
  IChartApi,
  ISeriesApi,
  SeriesType,
  Time,
} from "lightweight-charts"

import { stretchAfter, stretchedRange } from "@/lib/price-axis"

export type ZoomChange =
  // A gesture left the time axis at `barSpacing` px a minute.
  | { readonly _tag: "Time"; readonly barSpacing: number }
  // A double click on the time axis: the chart's default time zoom.
  | { readonly _tag: "TimeReset" }
  // A price axis drag left it `stretch` times tighter than its fit.
  | { readonly _tag: "Price"; readonly stretch: number }
  // A double click on the price axis: its automatic fit.
  | { readonly _tag: "PriceReset" }

// A wheel's zoom is over once no notch has come for this long.
const WHEEL_SETTLE_MS = 400

// `base`, the series' automatic fit, tightened `stretch` times.
const stretchedFit =
  (base: AutoscaleInfoProvider, stretch: number): AutoscaleInfoProvider =>
  (original) => {
    const info = base(original)
    if (info?.priceRange == null || stretch === 1) return info
    return {
      ...info,
      priceRange: Effect.runSync(stretchedRange(info.priceRange, stretch)),
    }
  }

// Holds `series`' price axis (pane 0's) at `stretch` times tighter than
// `base`, and tells `zoomed` what each zoom gesture on `chart` leaves. A range
// change no gesture made, a refit or a resize, tells it nothing. The chart
// itself must not reset its time axis on a double click (the chart saves and
// shows its own default). Returns the detach.
// Decision: the price axis keeps autoscale on. Lightweight Charts 5.2.1's
// price axis drag turns it off and freezes the range; once the drag is over,
// the range it left, as a stretch of the fit it started from, goes into the
// autoscale and autoscale comes back on, so the axis follows the price again.
export const watchZoom = ({
  chart,
  element,
  series,
  base,
  stretch,
  zoomed,
}: {
  readonly chart: IChartApi
  readonly element: HTMLElement
  readonly series: ISeriesApi<SeriesType, Time>
  readonly base: AutoscaleInfoProvider
  readonly stretch: number | undefined
  readonly zoomed: (change: ZoomChange) => void
}) => {
  let shown = stretch ?? 1
  const stretchTo = (next: number) => {
    shown = next
    series.applyOptions({ autoscaleInfoProvider: stretchedFit(base, next) })
    element.dataset.priceStretch = next.toFixed(3)
  }
  stretchTo(shown)

  const spacing = () => chart.timeScale().options().barSpacing
  const priceHeight = () => {
    const range = series.priceScale().getVisibleRange()
    return range === null ? undefined : range.to - range.from
  }
  // Reports the time axis' zoom if it moved since the gesture began.
  const timeSince = (began: number) => {
    const now = spacing()
    if (Math.abs(now - began) > 1e-6) zoomed({ _tag: "Time", barSpacing: now })
  }

  // Each pointer's gesture, from where the axes were when it went down.
  let pressed: { spacing: number; height: number | undefined } | undefined
  const press = (event: PointerEvent) => {
    if (event.button === 0)
      pressed = { spacing: spacing(), height: priceHeight() }
  }
  const release = () => {
    if (pressed === undefined) return
    const began = pressed
    pressed = undefined
    timeSince(began.spacing)
    if (series.priceScale().options().autoScale) return
    const after = priceHeight()
    series.priceScale().setAutoScale(true)
    if (began.height === undefined || after === undefined || after <= 0) return
    const next = Effect.runSync(stretchAfter(shown, began.height, after))
    stretchTo(next)
    zoomed({ _tag: "Price", stretch: next })
  }

  let wheelBegan: number | undefined
  let wheelTimer: ReturnType<typeof setTimeout> | undefined
  const wheelOver = () => {
    clearTimeout(wheelTimer)
    const began = wheelBegan
    wheelBegan = undefined
    if (began !== undefined) timeSince(began)
  }
  const wheel = () => {
    wheelBegan ??= spacing()
    clearTimeout(wheelTimer)
    wheelTimer = setTimeout(wheelOver, WHEEL_SETTLE_MS)
  }

  // A double click on an axis: the price axis right of the panes, pane 0's
  // only, and the time axis below them.
  const doubleClick = (event: MouseEvent) => {
    const box = element.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    const timeScale = chart.timeScale()
    if (x >= timeScale.width()) {
      if (y >= (chart.panes()[0]?.getHeight() ?? 0)) return
      stretchTo(1)
      zoomed({ _tag: "PriceReset" })
    } else if (y >= element.clientHeight - timeScale.height())
      zoomed({ _tag: "TimeReset" })
  }

  const heard = new AbortController()
  // In the capture phase: before the chart's own handlers zoom it.
  const capturing = { passive: true, capture: true, signal: heard.signal }
  element.addEventListener("pointerdown", press, capturing)
  element.addEventListener("wheel", wheel, capturing)
  element.addEventListener("dblclick", doubleClick, { signal: heard.signal })
  // A press anywhere ends a wheel's zoom first: a click that jumps the chart
  // right after the wheel fits it to the zoom the wheel left.
  window.addEventListener("pointerdown", wheelOver, capturing)
  window.addEventListener("pointerup", release, capturing)
  window.addEventListener("pointercancel", release, capturing)
  return () => {
    heard.abort()
    clearTimeout(wheelTimer)
  }
}
