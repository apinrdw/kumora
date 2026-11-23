// The order flow events' marks (spec apinrdw/kumora#605, "Order flow events:
// on the page"): a series primitive that marks each of the selected code's
// order flow events on its minute, ▲ for a buying-side event and ▼ for a
// selling-side one, in the aggressor side's colour with the kind's letter
// beside it. The candle chart puts ▲ above the minute's high and ▼ below its
// low, beside the book events' ◆ and ■; the footprint chart puts them in a
// row along its top. A minute's marks that would meet stack outward from
// the candle, or down the row, each with its own hit target. A recorded
// day's events its cursor hasn't reached are left off
// (lib/order-flow-marks.ts). Hovering a mark shows its tooltip
// (order-flow-tip.tsx), and a click or a tap pins it. Loaded only with the
// charts' canvases, in the browser.
import { Effect } from "effect"
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  MouseEventParams,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import { orderFlowMarks, type OrderFlowMark } from "@/lib/order-flow-marks"
import { cursorLogical } from "@/lib/replay"

import type { BookEventStore } from "./book-event-store"
import type { CandleStore } from "./candle-store"
import type { ListenerStore } from "./listener-store"
import type { ReplayCursor } from "./replay-cursor"

// A triangle's half width, and how far its centre sits from the candle's
// high or low, in CSS pixels.
const HALF = 6
const OFF = 13
// The footprint chart's row: its marks' centre, below the pane's top.
const ROW_Y = 10
// How far apart a minute's stacked marks' centres sit.
const STACK = 2 * HALF + 3
// How near the pointer must be to a mark's centre to be on it.
const HIT = 11

interface Colors {
  readonly buy: string
  readonly sell: string
  readonly edge: string
  readonly picked: string
}

// The order flow tooltip's place, in viewport pixels, and its event's key.
export interface OrderFlowTipAt {
  readonly key: string
  readonly x: number
  readonly y: number
  // Shown by a click or a tap, not a hover: a hover leaves it be.
  readonly pinned: boolean
}

interface Placed {
  readonly mark: OrderFlowMark
  readonly x: number
  readonly y: number
}

// Draws each shown mark at its minute's centre. The last draw's count and
// the picked mark's centre go on `marks` for the page e2e.
class OrderFlowMarks implements ISeriesPrimitive<Time> {
  private shown: ReadonlyArray<OrderFlowMark> = []
  private picked: string | undefined
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const placed = this.placed()
        const h = scope.horizontalPixelRatio
        const v = scope.verticalPixelRatio
        const context = scope.context
        let ring: readonly [number, number] | undefined
        context.lineWidth = Math.max(1, h)
        context.font = `600 ${11 * v}px ui-monospace, SFMono-Regular, Menlo, monospace`
        context.textBaseline = "middle"
        context.textAlign = "left"
        for (const { mark, x, y } of placed) {
          const bx = x * h
          const by = y * v
          const tip = mark.above ? -HALF * v : HALF * v
          const color = this.colors[mark.event.side]
          context.beginPath()
          context.moveTo(bx, by + tip)
          context.lineTo(bx + HALF * h, by - 0.8 * tip)
          context.lineTo(bx - HALF * h, by - 0.8 * tip)
          context.closePath()
          context.fillStyle = color
          context.strokeStyle = this.colors.edge
          context.fill()
          context.stroke()
          context.fillText(mark.letter, bx + (HALF + 3) * h, by)
          if (mark.key === this.picked) ring = [bx, by]
        }
        if (ring !== undefined) {
          context.lineWidth = 2 * h
          context.strokeStyle = this.colors.picked
          context.beginPath()
          context.arc(ring[0], ring[1], HIT * h, 0, Math.PI * 2)
          context.stroke()
        }
        this.marks.dataset.orderFlowMarks = String(placed.length)
        if (ring === undefined) delete this.marks.dataset.pickedOrderFlowAt
        else
          this.marks.dataset.pickedOrderFlowAt = `${ring[0] / h},${ring[1] / v}`
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "top", renderer: () => this.renderer },
  ]

  constructor(
    private readonly colors: Colors,
    private readonly marks: HTMLElement,
    private readonly row: boolean
  ) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  paneViews() {
    return this.views
  }

  show(marks: ReadonlyArray<OrderFlowMark>, picked: string | undefined) {
    this.shown = marks
    this.picked = picked
    this.attachedTo?.requestUpdate()
  }

  // The mark a point of the pane is on, the nearest of several.
  at(x: number, y: number) {
    let best: { mark: OrderFlowMark; distance: number } | undefined
    for (const each of this.placed()) {
      const distance = Math.hypot(each.x - x, each.y - y)
      if (distance <= HIT && (best === undefined || distance < best.distance))
        best = { mark: each.mark, distance }
    }
    return best?.mark
  }

  // The marks at the chart's current scale, in CSS pixels, each at its
  // minute's centre.
  // Decision: a candle-less minute's mark sits where the cursor line would
  // (apps/dashboard/docs/adr/0024-chart-marks-in-an-empty-minute-sit-where-the-cursor-would.md)
  private placed(): ReadonlyArray<Placed> {
    const attached = this.attachedTo
    if (attached === undefined) return []
    const timeScale = attached.chart.timeScale()
    let bars: ReadonlyArray<number> | undefined
    const xOf = (minute: number) => {
      const centre = timeScale.timeToCoordinate((minute / 1000) as Time)
      if (centre !== null) return centre
      bars ??= attached.series.data().map((bar) => bar.time as number)
      return timeScale.logicalToCoordinate(
        Effect.runSync(cursorLogical(bars, minute)) as Logical
      )
    }
    // How many marks already sit at each minute's place: a side of its
    // candle, or the row.
    const stacked = new Map<string, number>()
    return this.shown.flatMap((mark) => {
      const x = xOf(mark.minute)
      const price = this.row
        ? ROW_Y
        : attached.series.priceToCoordinate(mark.price)
      if (x === null || price === null) return []
      const place = this.row ? `${mark.minute}` : `${mark.minute}|${mark.above}`
      const below = stacked.get(place) ?? 0
      stacked.set(place, below + 1)
      const y = this.row
        ? ROW_Y + below * STACK
        : price + (mark.above ? -1 : 1) * (OFF + below * STACK)
      return [{ mark, x, y }]
    })
  }
}

// Marks `store`'s order flow events on `series` until `detach`, redrawn at
// most once an animation frame when they, the picked one, the candles or the
// cursor change. `row` puts them in the footprint chart's row. Returns
// `click`, which the chart's click handler calls first: a click or a tap on
// a mark pins its tooltip, and it says whether it was on one.
export function attachOrderFlowMarks({
  chart,
  series,
  store,
  candles,
  cursor,
  colors,
  marks,
  tip,
  row = false,
}: {
  chart: IChartApi
  series: ISeriesApi<SeriesType, Time>
  store: BookEventStore
  candles: Pick<CandleStore, "candles" | "subscribe">
  cursor: ReplayCursor | undefined
  colors: Colors
  marks: HTMLElement
  tip: ListenerStore<OrderFlowTipAt | undefined>
  row?: boolean
}) {
  const primitive = new OrderFlowMarks(colors, marks, row)
  series.attachPrimitive(primitive)
  let frame = 0
  const redraw = () => {
    frame = 0
    const shown = Effect.runSync(
      orderFlowMarks(
        store.orderFlowEvents(),
        candles.candles(),
        cursor?.state().at ?? Number.POSITIVE_INFINITY
      )
    )
    primitive.show(shown, store.picked())
    // A tooltip whose mark the cursor moved back before hides.
    const key = tip.get()?.key
    if (key !== undefined && !shown.some((mark) => mark.key === key))
      tip.set(undefined)
  }
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(redraw)
  }
  redraw()
  const stopStore = store.subscribe(schedule)
  const stopCandles = candles.subscribe(schedule)
  const stopCursor = cursor?.subscribe(schedule)
  // The tooltip of the mark at the pointer, or none once it is on no mark;
  // a pinned one is left alone by a hover. A point in another pane (the
  // volume, the footer) is on no mark.
  const show = (parameter: MouseEventParams<Time>, pin: boolean) => {
    const point =
      parameter.paneIndex === series.getPane().paneIndex()
        ? parameter.point
        : undefined
    const mark = point && primitive.at(point.x, point.y)
    const shown = tip.get()
    if (!pin && shown?.pinned) return mark
    if (mark === undefined || point === undefined) {
      if (!pin) tip.set(undefined)
      return mark
    }
    const box = chart.chartElement().getBoundingClientRect()
    tip.set({
      key: mark.key,
      x: box.left + point.x,
      y: box.top + point.y,
      pinned: pin,
    })
    return mark
  }
  const hover = (parameter: MouseEventParams<Time>) =>
    void show(parameter, false)
  chart.subscribeCrosshairMove(hover)
  return {
    click: (parameter: MouseEventParams<Time>) =>
      show(parameter, true) !== undefined,
    detach: () => {
      stopStore()
      stopCandles()
      stopCursor?.()
      cancelAnimationFrame(frame)
      chart.unsubscribeCrosshairMove(hover)
      tip.set(undefined)
      series.detachPrimitive(primitive)
    },
  }
}
