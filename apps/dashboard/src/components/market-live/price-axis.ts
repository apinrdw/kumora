// Both charts' price axis on IDX ticks (spec apinrdw/kumora#263, "IDX tick
// axis"): the library's own labels are hidden and `TickAxis` draws a label
// and a gridline at every tick of each band in view, thinned below 13 px a row
// (lib/price-axis.ts). Loaded only in the browser, by the chart canvases.
import { Effect } from "effect"
import type {
  AutoscaleInfoProvider,
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import { idxTick } from "@/lib/footprint"
import { labelPrices, priceLabel, rowCappedRange } from "@/lib/price-axis"

// A label keeps this far from the pane's top and bottom edges, in px.
const EDGE_PX = 6

class TickAxis implements ISeriesPrimitive<Time> {
  private labels: ReadonlyArray<ISeriesPrimitiveAxisView> = []
  private lines: ReadonlyArray<number> = []
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const { context, verticalPixelRatio: v } = scope
        context.fillStyle = this.grid
        const width = Math.max(1, Math.floor(v))
        for (const y of this.lines)
          context.fillRect(0, Math.round(y * v), scope.bitmapSize.width, width)
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "bottom", renderer: () => this.renderer },
  ]

  constructor(
    private readonly text: string,
    private readonly grid: string
  ) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  // The view moved: work the labels out again.
  updateAllViews() {
    const series = this.attachedTo?.series
    if (series === undefined) return
    const height = series.getPane().getHeight()
    const top = series.coordinateToPrice(0)
    const bottom = series.coordinateToPrice(height)
    if (top === null || bottom === null || height === 0) {
      this.labels = []
      this.lines = []
      return
    }
    const labels: Array<ISeriesPrimitiveAxisView> = []
    const lines: Array<number> = []
    for (const at of Effect.runSync(labelPrices({ bottom, top, height }))) {
      const y = series.priceToCoordinate(at)
      if (y === null || y < EDGE_PX || y > height - EDGE_PX) continue
      const text = Effect.runSync(priceLabel(at))
      lines.push(y)
      labels.push({
        coordinate: () => y,
        text: () => text,
        textColor: () => this.text,
        backColor: () => "transparent",
      })
    }
    this.labels = labels
    this.lines = lines
  }

  priceAxisViews() {
    return this.labels
  }

  paneViews() {
    return this.views
  }
}

// Puts `series`' price axis on IDX ticks: its labels and gridlines come
// from `TickAxis`, and the crosshair's price snaps to a valid price. The
// chart's own horizontal grid lines must be off. `setPrice` moves
// `minMove` to the tick of the code's latest price.
export const idxPriceAxis = (
  series: ISeriesApi<SeriesType, Time>,
  colors: { readonly text: string; readonly grid: string }
) =>
  Effect.sync(() => {
    series
      .priceScale()
      .applyOptions({ textColor: "transparent", ticksVisible: false })
    series.attachPrimitive(new TickAxis(colors.text, colors.grid))
    let tick = 0
    const setPrice = (latest: number | undefined) => {
      const next = Effect.runSync(idxTick(latest ?? 0))
      if (next === tick) return
      tick = next
      // The series' own price format, never the chart-wide
      // `localization.priceFormatter`, which would override the footer's
      // blank one (spec apinrdw/kumora#263, "Further Notes").
      series.applyOptions({
        priceFormat: {
          type: "custom",
          minMove: tick,
          formatter: (value: number) => Effect.runSync(priceLabel(value)),
        },
      })
    }
    setPrice(undefined)
    return { setPrice }
  })

// The footprint chart's autoscale: the visible minutes' range, widened until a
// row is at most 36 px of `chart`'s first pane (lib/price-axis.ts
// `rowCappedRange`).
export const rowCapped =
  (chart: IChartApi): AutoscaleInfoProvider =>
  (original) => {
    const info = original()
    const paneHeight = chart.panes()[0]?.getHeight() ?? 0
    if (info?.priceRange == null || paneHeight === 0) return info
    return {
      ...info,
      priceRange: Effect.runSync(
        rowCappedRange({ ...info.priceRange, paneHeight })
      ),
    }
  }
