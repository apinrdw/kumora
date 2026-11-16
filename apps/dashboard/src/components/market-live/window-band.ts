// The candle chart's shade over the minutes the footprint chart shows, with
// teal edges (spec apinrdw/kumora#263, "Window band"). Loaded only in the
// browser.
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts"

import { Effect } from "effect"

import type { BarRange } from "@/lib/chart-nav"

class WindowBand implements ISeriesPrimitive<Time> {
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const range = this.range()
        const timeScale = this.attachedTo?.chart.timeScale()
        if (range === null || timeScale === undefined) return
        // Whole bars only: Lightweight Charts 5.2.1's logicalToCoordinate
        // answers 0 for a fractional position.
        const first = Math.max(0, Math.ceil(range.from))
        const last = Math.floor(range.to)
        if (last < first) return
        const left = timeScale.logicalToCoordinate(first as Logical)
        const right = timeScale.logicalToCoordinate(last as Logical)
        if (left === null || right === null) return
        const half = timeScale.options().barSpacing / 2
        const { context, horizontalPixelRatio: h } = scope
        const height = scope.bitmapSize.height
        const from = Math.round((left - half) * h)
        const to = Math.round((right + half) * h)
        const edge = 2 * Math.max(1, Math.floor(h))
        context.fillStyle = this.shade
        context.fillRect(from, 0, to - from, height)
        context.fillStyle = this.edge
        context.fillRect(from, 0, edge, height)
        context.fillRect(to - edge, 0, edge, height)
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "top", renderer: () => this.renderer },
  ]

  constructor(
    // The footprint chart's visible logical range: both charts draw the same
    // minutes.
    private readonly range: () => BarRange | null,
    private readonly shade: string,
    private readonly edge: string
  ) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  // The footprint chart moved.
  update() {
    this.attachedTo?.requestUpdate()
  }

  paneViews() {
    return this.views
  }
}

// The band for the candle chart's candle series, drawn over `range`'s whole
// bars.
export const makeWindowBand = (
  range: () => BarRange | null,
  shade: string,
  edge: string
) =>
  Effect.sync(
    (): ISeriesPrimitive<Time> & { readonly update: () => void } =>
      new WindowBand(range, shade, edge)
  )
