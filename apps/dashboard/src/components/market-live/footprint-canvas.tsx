// Chart 2, the selected code's footprint (spec apinrdw/kumora#263, "Chart
// 2"): Lightweight Charts, loaded only in the browser (footprint-chart.tsx
// lazy-loads this module inside ClientOnly), so the Worker never bundles it.
//
// Layout for the tickets after apinrdw/kumora#264:
// - pane 0: `FootprintView`, a custom series of one `FootprintColumn` per
//   minute (lib/footprint.ts works the columns out, so the view only draws).
//   View modes, imbalance and POC (apinrdw/kumora#269) are its options.
// - pane 1: `FooterView`, the Vol / Δ / CVD cells, with `FooterLabels` in
//   the price-scale strip.
// - chart-pair.ts opens and refits its 10-minute window and pans it with
//   chart 1; price-axis.ts labels its IDX ticks and caps its rows; the hover
//   ladder is footprint-ladder.tsx.
import type { RelayGap } from "@workspace/relay"
import { Effect } from "effect"
import {
  LineSeries,
  LineStyle,
  createChart,
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  type MouseEventParams,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { useEffect, useRef, useState } from "react"

import { chartMinutes } from "@/lib/chart-nav"
import type { ChartSettings, FootprintMode } from "@/lib/chart-settings"
import {
  MIN_FONT_PX,
  drawMode,
  footerLabelled,
  footprintColumns,
  type DrawMode,
  type FootprintColumn,
  type FootprintRow,
} from "@/lib/footprint"
import { footprintLadder } from "@/lib/footprint-ladder"

import type { CandleStore } from "./candle-store"
import type { ChartPair } from "./chart-pair"
import { CHART_SCALE_WIDTH, crosshairTime, tickMark } from "./chart-time"
import type { HeaderStore } from "./footprint-header"
import { FootprintLadder, makeLadderStore } from "./footprint-ladder"
import { idxPriceAxis, rowCapped } from "./price-axis"
import type { ReplayCursor } from "./replay-cursor"

const MINUTE = 60_000

type Target = Parameters<ICustomSeriesPaneRenderer["draw"]>[0]
type Scope = Parameters<Parameters<Target["useBitmapCoordinateSpace"]>[0]>[0]

// One minute of chart 2 as both its series hold it.
interface ColumnItem extends CustomData<Time> {
  readonly column: FootprintColumn
}

// The theme tokens chart 2 draws with.
interface Palette {
  readonly up: string
  readonly down: string
  readonly neutral: string
  readonly muted: string
  readonly text: string
  readonly border: string
  readonly warn: string
  readonly imbalanceBuy: string
  readonly imbalanceSell: string
}

// One minute's column to draw as cells, and where: `left` is its left edge
// and `spacing` its width in CSS px, `px` its font size, and `text` whether
// it has room for full text rather than compact.
interface Cell {
  readonly scope: Scope
  readonly toY: PriceToCoordinateConverter
  readonly column: FootprintColumn
  readonly left: number
  readonly spacing: number
  readonly px: number
  readonly text: boolean
  readonly color: string
  readonly poc: boolean
}

const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace"

// What the views share: fonts that shrink to fit, and a candle.
class Drawing {
  constructor(protected readonly palette: Palette) {}

  // A token's colour at `alpha` (0–1): the tokens are #rrggbb.
  protected alpha(color: string, alpha: number) {
    return `${color}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
      .toString(16)
      .padStart(2, "0")}`
  }

  // Sets the font at `px`, shrunk (down to 6 px) until `width` fits `room`
  // bitmap px.
  protected fit(
    context: CanvasRenderingContext2D,
    px: number,
    pixelRatio: number,
    room: number,
    width: (context: CanvasRenderingContext2D) => number
  ) {
    context.font = `${px * pixelRatio}px ${FONT}`
    const wide = width(context)
    if (wide <= room || wide === 0) return
    context.font = `${Math.max(MIN_FONT_PX, (px * room) / wide) * pixelRatio}px ${FONT}`
  }

  protected candle(
    scope: Scope,
    toY: PriceToCoordinateConverter,
    column: FootprintColumn,
    centre: number,
    bodyWidth: number,
    color: string
  ) {
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    const y = (price: number) => (toY(price) ?? 0) * v
    const x = Math.round(centre * h)
    const wick = Math.max(1, Math.floor(h))
    context.fillStyle = color
    const high = Math.round(y(column.high))
    context.fillRect(
      x - Math.floor(wick / 2),
      high,
      wick,
      Math.max(1, Math.round(y(column.low)) - high)
    )
    const body = Math.max(wick, Math.round(bodyWidth * h))
    const top = Math.round(Math.min(y(column.open), y(column.close)))
    context.fillRect(
      x - Math.floor(body / 2),
      top,
      body,
      Math.max(1, Math.round(Math.abs(y(column.close) - y(column.open))))
    )
  }
}

// What chart 2's view draws by setting: its view mode, and whether it
// outlines each minute's POC.
interface ViewOptions {
  readonly mode: FootprintMode
  readonly poc: boolean
}

// What one draw of the footprint showed, for the page to read: its draw mode
// by width, its view mode, and how many imbalance figures and POC outlines
// it drew.
interface FootprintDraw {
  readonly mode: DrawMode
  readonly view: FootprintMode
  readonly imbalances: number
  readonly pocs: number
}

// One draw's scale, widths and settings, shared by every minute it draws.
interface Frame {
  readonly scope: Scope
  readonly toY: PriceToCoordinateConverter
  readonly spacing: number
  readonly rowHeight: number
  readonly mode: DrawMode
  readonly options: ViewOptions
}

// One price row's place in bitmap px: its top and bottom edges and middle.
interface RowBox {
  readonly top: number
  readonly bottom: number
  readonly y: number
}

// The footprint: each minute's lots at every price it traded, in the view
// mode picked (Stacked `sell × buy` cells, Side by side halves, or a
// Footprint volume profile) at text and compact widths, split bars or a
// candle when narrower (lib/footprint.ts `drawMode`), and a plain candle in
// the Candles view. Imbalanced figures take the imbalance tokens, and each
// minute's POC is outlined in the warn token. A minute after the cursor is a
// grey candle.
class FootprintView
  extends Drawing
  implements ICustomSeriesPaneView<Time, ColumnItem>
{
  private data: PaneRendererCustomData<Time, ColumnItem> | undefined
  private readonly painter: ICustomSeriesPaneRenderer = {
    draw: (target, toY) =>
      target.useBitmapCoordinateSpace((scope) => this.draw(scope, toY)),
  }
  private imbalances = 0
  private pocs = 0

  constructor(
    palette: Palette,
    private readonly options: () => ViewOptions,
    // Told what each draw showed, for the page to say what it shows.
    private readonly drawn: (draw: FootprintDraw) => void
  ) {
    super(palette)
  }

  renderer() {
    return this.painter
  }

  update(data: PaneRendererCustomData<Time, ColumnItem>) {
    this.data = data
  }

  priceValueBuilder(item: ColumnItem) {
    return [item.column.low, item.column.high, item.column.close]
  }

  isWhitespace(
    item: ColumnItem | CustomSeriesWhitespaceData<Time>
  ): item is CustomSeriesWhitespaceData<Time> {
    return !("column" in item)
  }

  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions
  }

  // How tall a row is on screen, in CSS px: one tick of the first visible
  // row; none while no row is visible.
  private rowHeight(toY: PriceToCoordinateConverter) {
    const { bars, visibleRange } = this.data!
    for (let i = visibleRange!.from; i < visibleRange!.to; i++) {
      const row = bars[i]?.originalData.column.rows[0]
      if (row === undefined) continue
      const top = toY(row.price + row.half)
      const bottom = toY(row.price - row.half)
      if (top !== null && bottom !== null) return Math.abs(bottom - top)
    }
    return Number.POSITIVE_INFINITY
  }

  private draw(scope: Scope, toY: PriceToCoordinateConverter) {
    if (this.data?.visibleRange == null) return
    const { bars, barSpacing, visibleRange } = this.data
    const rowHeight = this.rowHeight(toY)
    const frame: Frame = {
      scope,
      toY,
      spacing: barSpacing,
      rowHeight,
      mode: Effect.runSync(drawMode(barSpacing, rowHeight)),
      options: this.options(),
    }
    this.imbalances = 0
    this.pocs = 0
    scope.context.textBaseline = "middle"
    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const bar = bars[i]
      if (bar !== undefined) this.minute(frame, bar.originalData.column, bar.x)
    }
    this.drawn({
      mode: frame.mode,
      view: frame.options.mode,
      imbalances: this.imbalances,
      pocs: this.pocs,
    })
  }

  // One minute's column, centred on `x`: a candle when it has no cells to
  // show, else split bars or its view mode's cells.
  private minute(frame: Frame, column: FootprintColumn, x: number) {
    const { scope, toY, spacing, rowHeight, mode, options } = frame
    const color = column.later
      ? this.alpha(this.palette.muted, 0.33)
      : column.close >= column.open
        ? this.palette.up
        : this.palette.down
    const plain =
      column.later ||
      mode === "candles" ||
      options.mode === "candles" ||
      column.rows.length === 0
    if (plain)
      return this.candle(
        scope,
        toY,
        column,
        x,
        Math.max(1, spacing * 0.6),
        color
      )
    if (mode === "bars") return this.bars(scope, toY, column, x, spacing, color)
    const text = mode === "text"
    const cell: Cell = {
      scope,
      toY,
      column,
      left: x - spacing / 2,
      spacing,
      px: Math.min(text ? 11 : 9, rowHeight - 1),
      text,
      color,
      poc: options.poc,
    }
    if (options.mode === "side") this.side(cell)
    else if (options.mode === "profile") this.profile(cell)
    else this.cells(cell)
  }

  private box(
    scope: Scope,
    toY: PriceToCoordinateConverter,
    row: FootprintRow
  ) {
    const v = scope.verticalPixelRatio
    const top = Math.round((toY(row.price + row.half) ?? 0) * v)
    const bottom = Math.round((toY(row.price - row.half) ?? 0) * v)
    return { top, bottom, y: (top + bottom) / 2 } satisfies RowBox
  }

  // The POC's outline round a row `wide` CSS px from `left`.
  private outline(
    cell: Cell,
    row: FootprintRow,
    box: RowBox,
    left: number,
    wide: number
  ) {
    if (!cell.poc || row.price !== cell.column.poc) return
    const { context, horizontalPixelRatio: h } = cell.scope
    context.strokeStyle = this.palette.warn
    context.lineWidth = Math.max(1, h)
    context.strokeRect(
      Math.round(left * h) + 0.5,
      box.top + 0.5,
      Math.round(wide * h) - 1,
      Math.max(1, box.bottom - box.top - 2)
    )
    this.pocs += 1
  }

  // A side's figure colour: the imbalance token when it is one.
  private sellTone(row: FootprintRow) {
    if (!row.sellImbalance) return this.palette.down
    this.imbalances += 1
    return this.palette.imbalanceSell
  }

  private buyTone(row: FootprintRow) {
    if (!row.buyImbalance) return this.palette.up
    this.imbalances += 1
    return this.palette.imbalanceBuy
  }

  // Split bars: a thin candle, then each price's sell, buy and no-side lots
  // as bars against the minute's largest price.
  private bars(
    scope: Scope,
    toY: PriceToCoordinateConverter,
    column: FootprintColumn,
    x: number,
    spacing: number,
    color: string
  ) {
    const { context, horizontalPixelRatio: h } = scope
    this.candle(
      scope,
      toY,
      column,
      x - spacing * 0.32,
      Math.max(1, spacing * 0.12),
      color
    )
    const left = x - spacing * 0.22
    const room = spacing * 0.66
    const most = column.most || 1
    for (const row of column.rows) {
      const { top, bottom } = this.box(scope, toY, row)
      const tall = Math.max(1, bottom - top - 1)
      let from = left
      for (const [lots, tone] of [
        [row.sell, this.alpha(this.palette.down, 0.75)],
        [row.buy, this.alpha(this.palette.up, 0.75)],
        [row.none, this.alpha(this.palette.muted, 0.6)],
      ] as const) {
        if (lots === 0) continue
        const wide = (room * lots) / most
        context.fillStyle = tone
        context.fillRect(
          Math.round(from * h),
          top,
          Math.max(1, Math.round(wide * h)),
          tall
        )
        from += wide
      }
    }
  }

  // Stacked cells: `sell × buy` per price (compact: no ×, a smaller font),
  // on a tint of the side with more lots, deeper the more the price traded.
  // A price with only no-side lots shows them alone, muted.
  private cells(cell: Cell) {
    const { scope, toY, column, left, spacing, px, text, color } = cell
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    const inset = text ? 8 : 4
    this.candle(scope, toY, column, left + inset / 2, text ? 3 : 2, color)
    const centre = left + inset + 1 + (spacing - inset - 3) / 2
    const gap = text ? 5 : 1.5
    const half = ((spacing - inset - 4) / 2 - gap) * h
    const most = column.most || 1
    for (const row of column.rows) {
      const box = this.box(scope, toY, row)
      const tint = 0.06 + (0.3 * (row.sell + row.buy)) / most
      context.fillStyle = this.alpha(
        row.buy >= row.sell ? this.palette.up : this.palette.down,
        tint
      )
      context.fillRect(
        Math.round((left + inset) * h),
        box.top,
        Math.round((spacing - inset - 2) * h),
        Math.max(1, box.bottom - box.top - 1)
      )
      this.outline(cell, row, box, left + inset, spacing - inset - 2)
      if (row.sell === 0 && row.buy === 0) {
        this.fit(
          context,
          px,
          v,
          2 * half,
          (c) => c.measureText(row.noneText).width
        )
        context.textAlign = "center"
        context.fillStyle = this.palette.muted
        context.fillText(row.noneText, centre * h, box.y)
        continue
      }
      this.fit(context, px, v, half, (c) =>
        Math.max(
          c.measureText(row.sellText).width,
          c.measureText(row.buyText).width
        )
      )
      context.textAlign = "right"
      context.fillStyle = this.sellTone(row)
      context.fillText(row.sellText, (centre - gap) * h, box.y)
      if (text) {
        context.textAlign = "center"
        context.fillStyle = this.palette.muted
        context.fillText("×", centre * h, box.y)
      }
      context.textAlign = "left"
      context.fillStyle = this.buyTone(row)
      context.fillText(row.buyText, (centre + gap) * h, box.y)
    }
  }

  // Side by side: a sell half and a buy half per price, each shaded by its
  // own lots against the minute's largest side.
  private side(cell: Cell) {
    const { scope, toY, column, left, spacing, px, color } = cell
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    this.candle(scope, toY, column, left + 3, 2, color)
    const from = left + 6
    const wide = spacing - 8
    const half = wide / 2
    let most = 1
    for (const row of column.rows) most = Math.max(most, row.sell, row.buy)
    for (const row of column.rows) {
      const box = this.box(scope, toY, row)
      const tall = Math.max(1, box.bottom - box.top - 1)
      context.fillStyle = this.alpha(
        this.palette.down,
        0.06 + (0.5 * row.sell) / most
      )
      context.fillRect(
        Math.round(from * h),
        box.top,
        Math.round((half - 1) * h),
        tall
      )
      context.fillStyle = this.alpha(
        this.palette.up,
        0.06 + (0.5 * row.buy) / most
      )
      context.fillRect(
        Math.round((from + half) * h),
        box.top,
        Math.round((half - 1) * h),
        tall
      )
      this.outline(cell, row, box, from, wide)
      this.fit(context, px, v, (half - 8) * h, (c) =>
        Math.max(
          c.measureText(row.sellText).width,
          c.measureText(row.buyText).width
        )
      )
      context.textAlign = "center"
      context.fillStyle = this.sellTone(row)
      context.fillText(row.sellText, (from + half / 2) * h, box.y)
      context.fillStyle = this.buyTone(row)
      context.fillText(row.buyText, (from + half * 1.5) * h, box.y)
    }
  }

  // Footprint: the minute's volume profile, one bar per price, its length
  // set by the price's lots against the busiest's and its colour by the side
  // that won (grey on a tie), with the total on it.
  private profile(cell: Cell) {
    const { scope, toY, column, left, spacing, px, color } = cell
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    this.candle(scope, toY, column, left + 3, 2, color)
    const from = left + 6
    const wide = spacing - 8
    const most = column.most || 1
    for (const row of column.rows) {
      const box = this.box(scope, toY, row)
      const total = row.sell + row.buy + row.none
      context.fillStyle =
        row.buy > row.sell
          ? this.alpha(this.palette.up, 0.55)
          : row.buy < row.sell
            ? this.alpha(this.palette.down, 0.55)
            : this.alpha(this.palette.neutral, 0.45)
      context.fillRect(
        Math.round(from * h),
        box.top,
        Math.round(Math.max(2, ((wide - 2) * total) / most) * h),
        Math.max(1, box.bottom - box.top - 1)
      )
      this.outline(cell, row, box, from, wide)
      this.fit(
        context,
        px,
        v,
        (wide - 6) * h,
        (c) => c.measureText(row.totalText).width
      )
      context.textAlign = "left"
      context.fillStyle = row.buyImbalance
        ? this.buyTone(row)
        : row.sellImbalance
          ? this.sellTone(row)
          : this.palette.text
      context.fillText(row.totalText, (from + 4) * h, box.y)
    }
  }
}

type FooterMode = "labelled" | "numbers" | "bars"

// The footer under the footprint: each minute's Vol, Δ and CVD as three
// rows of cells, labelled from 76 px a minute, numbers alone from 28 px, and
// as small bars below that. A minute after the cursor is left blank.
class FooterView
  extends Drawing
  implements ICustomSeriesPaneView<Time, ColumnItem>
{
  private data: PaneRendererCustomData<Time, ColumnItem> | undefined
  private readonly painter: ICustomSeriesPaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => this.draw(scope)),
  }

  constructor(
    palette: Palette,
    // Told how each draw wrote the cells: labelled, numbers alone, or bars.
    private readonly drawn: (mode: FooterMode) => void
  ) {
    super(palette)
  }

  renderer() {
    return this.painter
  }

  update(data: PaneRendererCustomData<Time, ColumnItem>) {
    this.data = data
  }

  priceValueBuilder() {
    return [0, 1]
  }

  isWhitespace(
    item: ColumnItem | CustomSeriesWhitespaceData<Time>
  ): item is CustomSeriesWhitespaceData<Time> {
    return !("column" in item)
  }

  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions
  }

  private shown() {
    const { bars, visibleRange } = this.data!
    const shown: Array<{
      readonly x: number
      readonly column: FootprintColumn
    }> = []
    for (let i = visibleRange!.from; i < visibleRange!.to; i++) {
      const bar = bars[i]
      if (bar !== undefined && !bar.originalData.column.later)
        shown.push({ x: bar.x, column: bar.originalData.column })
    }
    return shown
  }

  private draw(scope: Scope) {
    if (this.data?.visibleRange == null) return
    const { barSpacing } = this.data
    if (barSpacing >= 28) this.cells(scope, barSpacing)
    else {
      this.drawn("bars")
      this.bars(scope, barSpacing)
    }
  }

  private cells(scope: Scope, spacing: number) {
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    const band = scope.bitmapSize.height / 3
    const labelled = Effect.runSync(footerLabelled(spacing))
    this.drawn(labelled ? "labelled" : "numbers")
    const px = spacing >= 44 ? 10.5 : 9
    context.textBaseline = "middle"
    for (const { x, column } of this.shown()) {
      const centre = x * h
      const wide = (spacing - 3) * h
      const left = centre - wide / 2
      const { delta, cvd } = column.totals
      const rows = [
        [
          "Vol",
          column.volumeText,
          this.palette.text,
          this.alpha(this.palette.muted, 0.1),
        ],
        [
          "Δ",
          column.deltaText,
          delta >= 0 ? this.palette.up : this.palette.down,
          this.alpha(delta >= 0 ? this.palette.up : this.palette.down, 0.1),
        ],
        [
          "CVD",
          column.cvdText,
          cvd >= 0 ? this.palette.up : this.palette.down,
          this.alpha(cvd >= 0 ? this.palette.up : this.palette.down, 0.06),
        ],
      ] as const
      rows.forEach(([label, value, tone, fill], index) => {
        context.fillStyle = fill
        context.fillRect(
          Math.round(left),
          Math.round(band * index + v),
          Math.round(wide),
          Math.round(band - 2 * v)
        )
        const y = band * (index + 0.5)
        const room = wide - 8 * h
        context.font = `${px * v}px ${FONT}`
        if (
          labelled &&
          context.measureText(`${label}  ${value}`).width <= room
        ) {
          context.textAlign = "left"
          context.fillStyle = this.palette.muted
          context.fillText(label, left + 5 * h, y)
          context.textAlign = "right"
          context.fillStyle = tone
          context.fillText(value, left + wide - 5 * h, y)
          return
        }
        this.fit(context, px, v, room, (c) => c.measureText(value).width)
        context.textAlign = "center"
        context.fillStyle = tone
        context.fillText(value, centre, y)
      })
    }
  }

  // Too narrow for numbers: Vol as a bar, Δ and CVD as bars about each
  // row's middle, scaled to the largest shown.
  private bars(scope: Scope, spacing: number) {
    const { context, horizontalPixelRatio: h, verticalPixelRatio: v } = scope
    const band = scope.bitmapSize.height / 3
    const shown = this.shown()
    let volume = 1
    let delta = 1
    let cvd = 1
    for (const { column } of shown) {
      volume = Math.max(volume, column.totals.volume)
      delta = Math.max(delta, Math.abs(column.totals.delta))
      cvd = Math.max(cvd, Math.abs(column.totals.cvd))
    }
    const wide = Math.max(1, Math.round(spacing * 0.7 * h))
    const pad = 3 * v
    const half = band / 2 - pad
    for (const { x, column } of shown) {
      const left = Math.round(x * h - wide / 2)
      const tall = ((band - 2 * pad) * column.totals.volume) / volume
      context.fillStyle = this.palette.muted
      context.fillRect(left, band - pad - tall, wide, Math.max(1, tall))
      for (const [value, most, middle] of [
        [column.totals.delta, delta, band * 1.5],
        [column.totals.cvd, cvd, band * 2.5],
      ] as const) {
        const length = (half * Math.abs(value)) / most
        context.fillStyle = value >= 0 ? this.palette.up : this.palette.down
        context.fillRect(
          left,
          value >= 0 ? middle - length : middle,
          wide,
          Math.max(1, length)
        )
      }
    }
  }
}

// The footer's row labels, drawn in its price-scale strip.
class FooterLabels implements ISeriesPrimitive<Time> {
  private readonly views: ReadonlyArray<IPrimitivePaneView>

  constructor(palette: Palette) {
    this.views = [
      {
        renderer: () => ({
          draw: (target) =>
            target.useBitmapCoordinateSpace((scope) => {
              const { context } = scope
              const band = scope.bitmapSize.height / 3
              context.font = `600 ${10 * scope.verticalPixelRatio}px ui-sans-serif, system-ui`
              context.fillStyle = palette.muted
              context.textBaseline = "middle"
              context.textAlign = "left"
              ;["Vol", "Δ", "CVD"].forEach((label, index) =>
                context.fillText(
                  label,
                  8 * scope.horizontalPixelRatio,
                  band * (index + 0.5)
                )
              )
              context.fillStyle = palette.border
              context.fillRect(0, Math.round(band), scope.bitmapSize.width, 1)
              context.fillRect(
                0,
                Math.round(band * 2),
                scope.bitmapSize.width,
                1
              )
            }),
        }),
      },
    ]
  }

  paneViews() {
    return []
  }

  priceAxisPaneViews() {
    return this.views
  }
}

// The selected code's footprint and footer, drawn from the candle store on
// chart 1's minutes, relay `gaps` as whitespace. A change redraws both
// series at most once an animation frame; a snapshot (or a cursor on another
// minute) also reopens the 10-minute window. With `cursor`, a recorded day:
// the minutes after the cursor's are grey. Hovering a minute shows its
// ladder.
export default function FootprintCanvas({
  store,
  pair,
  gaps,
  settings,
  header,
  cursor,
}: {
  store: CandleStore
  pair: ChartPair
  gaps: ReadonlyArray<RelayGap>
  settings: ChartSettings
  header: HeaderStore
  cursor?: ReplayCursor | undefined
}) {
  const host = useRef<HTMLDivElement>(null)
  const shownGaps = useRef(gaps)
  const shownSettings = useRef(settings)
  const redrawNow = useRef<() => void>(undefined)
  const [ladder] = useState(makeLadderStore)

  useEffect(() => {
    const element = host.current
    if (element === null) return
    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const palette: Palette = {
      up: token("--semantic-up"),
      down: token("--semantic-down"),
      neutral: token("--semantic-neutral"),
      muted: token("--text-muted"),
      text: token("--text-primary"),
      border: token("--border-subtle"),
      warn: token("--semantic-warning"),
      imbalanceBuy: token("--chart-imbalance-buy"),
      imbalanceSell: token("--chart-imbalance-sell"),
    }
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: palette.muted,
        fontSize: 11,
        // Chart 1 carries the attribution, with the link under it.
        attributionLogo: false,
        panes: { separatorColor: palette.border },
      },
      // The price axis draws the horizontal lines, on IDX ticks.
      grid: {
        vertLines: { color: token("--chart-grid") },
        horzLines: { visible: false },
      },
      rightPriceScale: {
        borderColor: palette.border,
        minimumWidth: CHART_SCALE_WIDTH,
      },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: tickMark,
      },
      localization: { locale: "en-US", timeFormatter: crosshairTime },
    })
    // The page reads what the last draw showed (footprint-chart.tsx).
    const mark = (key: string, value: string | number) => {
      if (element.dataset[key] !== String(value))
        element.dataset[key] = String(value)
    }
    const footprint = chart.addCustomSeries(
      new FootprintView(
        palette,
        () => shownSettings.current,
        (draw) => {
          mark("drawMode", draw.mode)
          mark("viewMode", draw.view)
          mark("imbalances", draw.imbalances)
          mark("pocs", draw.pocs)
        }
      ),
      {
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: rowCapped(chart),
      }
    )
    const axis = idxPriceAxis(footprint, {
      text: palette.muted,
      grid: token("--chart-grid"),
    })
    footprint
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } })
    const footer = chart.addCustomSeries(
      new FooterView(palette, (mode) => mark("footer", mode)),
      {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: "custom", formatter: () => "" },
      },
      1
    )
    footer.attachPrimitive(new FooterLabels(palette))
    footer.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 } })
    // Decision: stretch factors, not `setHeight`: the chart may be made
    // before its holder has a size, and Lightweight Charts 5.2.1 keeps a
    // zero-size pane's height. See spec apinrdw/kumora#263, "Further Notes".
    chart.panes()[0]?.setStretchFactor(4)
    chart.panes()[1]?.setStretchFactor(1)

    // The day's VWAP, then its +1σ and −1σ bands out to ±3σ. They never
    // widen the price range, so the rows keep their height, and end at the
    // cursor.
    const line = (color: string, lineWidth: 1 | 2, lineStyle: LineStyle) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth,
        lineStyle,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
      })
    const vwapLines = [
      {
        sigmas: 0,
        series: line(token("--chart-day-vwap"), 2, LineStyle.Solid),
      },
      ...(
        [
          [1, "--chart-vwap-band-1", 0.75],
          [2, "--chart-vwap-band-2", 0.6],
          [3, "--chart-vwap-band-3", 0.5],
        ] as const
      ).flatMap(([sigmas, name, alpha]) => {
        const color = `${token(name)}${Math.round(alpha * 255).toString(16)}`
        return [sigmas, -sigmas].map((side) => ({
          sigmas: side,
          series: line(color, 1, LineStyle.Dashed),
        }))
      }),
    ]

    const cursorMinute = () =>
      cursor === undefined
        ? Number.POSITIVE_INFINITY
        : Math.floor(cursor.state().at / MINUTE) * MINUTE
    let shownMinute = cursorMinute()
    let columns: ReadonlyArray<FootprintColumn> = []
    // Every minute drawn, relay gaps' whitespace included, as chart 1 draws
    // them.
    let minutes: ReadonlyArray<number> = []
    const redraw = () => {
      const candles = store.candles()
      const chosen = shownSettings.current
      columns = Effect.runSync(
        footprintColumns(candles, store.footprints(), shownMinute, {
          imbalance: chosen.imbalance,
        })
      )
      const shown = Effect.runSync(
        chartMinutes(
          columns.map((column) => column.minute),
          shownGaps.current,
          cursor === undefined
            ? (columns.at(-1)?.minute ?? 0)
            : cursor.day.close
        )
      )
      minutes = shown.all
      const items: Array<ColumnItem | { time: UTCTimestamp }> = [
        ...columns.map((column) => ({
          time: (column.minute / 1000) as UTCTimestamp,
          column,
        })),
        ...shown.blank.map((minute) => ({
          time: (minute / 1000) as UTCTimestamp,
        })),
      ].sort((a, b) => a.time - b.time)
      footprint.setData(items)
      footer.setData(items)
      axis.setPrice(candles.at(-1)?.close)
      let points = 0
      for (const { sigmas, series } of vwapLines) {
        series.applyOptions({ visible: chosen.vwap })
        const data = columns.map((column) => {
          const time = (column.minute / 1000) as UTCTimestamp
          if (column.later || column.vwap === undefined) return { time }
          points += 1
          return {
            time,
            value: column.vwap.mean + sigmas * column.vwap.sigma,
          }
        })
        series.setData(data)
      }
      mark("vwapPoints", chosen.vwap ? points : 0)
      header.show(columns.filter((column) => !column.later).at(-1))
    }
    // The 10 minutes up to the cursor's (live: the last ones).
    const showWindow = () => pair.showUpTo(shownMinute)
    redraw()
    showWindow()
    redrawNow.current = redraw
    const unpair = pair.attachFootprint({
      chart,
      series: footprint,
      element,
      minutes: () => minutes,
    })

    // The hovered minute's ladder, at the pointer.
    const hover = (parameter: MouseEventParams<Time>) => {
      const item = parameter.seriesData.get(footprint) as ColumnItem | undefined
      const point = parameter.point
      header.hover(point === undefined ? undefined : item?.column)
      if (
        item?.column === undefined ||
        point === undefined ||
        item.column.later ||
        item.column.rows.length === 0
      )
        return ladder.set(undefined)
      const pointer =
        (parameter.paneIndex ?? 0) === 0
          ? (footprint.coordinateToPrice(point.y) ?? item.column.close)
          : item.column.close
      ladder.set({
        ladder: Effect.runSync(footprintLadder(item.column, pointer)),
        x: point.x,
        y: point.y,
        width: element.clientWidth,
      })
    }
    chart.subscribeCrosshairMove(hover)

    const stopCursor = cursor?.subscribe(() => {
      const minute = cursorMinute()
      if (minute === shownMinute) return
      shownMinute = minute
      redraw()
      showWindow()
    })
    let reset = columns.length === 0
    let frame = 0
    const unsubscribe = store.subscribe((change) => {
      if (change._tag === "Reset") reset = true
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        redraw()
        // The first minutes to arrive, or a snapshot, open the window.
        if (reset && columns.length > 0) {
          reset = false
          showWindow()
        }
      })
    })
    return () => {
      chart.unsubscribeCrosshairMove(hover)
      ladder.set(undefined)
      header.hover(undefined)
      unpair()
      redrawNow.current = undefined
      unsubscribe()
      stopCursor?.()
      cancelAnimationFrame(frame)
      chart.remove()
    }
  }, [store, cursor, pair, ladder, header])

  useEffect(() => {
    shownGaps.current = gaps
    redrawNow.current?.()
  }, [gaps])

  useEffect(() => {
    shownSettings.current = settings
    redrawNow.current?.()
  }, [settings])

  return (
    <div className="relative flex flex-col lg:flex-1">
      <div
        ref={host}
        className="h-[380px] w-full lg:h-auto lg:min-h-[380px] lg:flex-1"
        data-chart="footprint"
      />
      <FootprintLadder store={ladder} />
    </div>
  )
}
