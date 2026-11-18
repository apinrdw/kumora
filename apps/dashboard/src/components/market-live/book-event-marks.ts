// The book heatmap's event marks (spec apinrdw/kumora#517, "Book events"): a
// series primitive on the candles that marks each of the selected code's
// book events at its price and time, ◆ for absorbed, eaten and reloaded and
// ■ for a wall event, green on the bid and red on the offer. A recorded
// day's events after the cursor are left off. Loaded only with
// chart-canvas.tsx, in the browser.
import { MINUTE_MS, type BookEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import { WALL_KINDS, bookEventKey } from "@/lib/book-events"

import type { BookEventStore } from "./book-event-store"
import type { ReplayCursor } from "./replay-cursor"

// A mark's half width, in CSS pixels.
const HALF = 5

interface Colors {
  readonly bid: string
  readonly offer: string
  readonly edge: string
  readonly picked: string
}

// Draws each shown event as a mark, its x at its minute's centre plus its
// second, as the sweep bubbles sit. The last draw's count and the picked
// mark's centre go on `marks` for the page e2e.
class BookEventMarks implements ISeriesPrimitive<Time> {
  private events: ReadonlyArray<BookEvent> = []
  private picked: string | undefined
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const placed = this.placed()
        const ratio = scope.horizontalPixelRatio
        const vertical = scope.verticalPixelRatio
        const context = scope.context
        const half = HALF * ratio
        let ring: readonly [number, number] | undefined
        context.lineWidth = Math.max(1, ratio)
        for (const { event, key, x, y } of placed) {
          const bx = x * ratio
          const by = y * vertical
          context.beginPath()
          if (WALL_KINDS.has(event.kind))
            context.rect(bx - half, by - half, 2 * half, 2 * half)
          else {
            context.moveTo(bx, by - half - ratio)
            context.lineTo(bx + half + ratio, by)
            context.lineTo(bx, by + half + ratio)
            context.lineTo(bx - half - ratio, by)
            context.closePath()
          }
          context.fillStyle = this.colors[event.side]
          context.strokeStyle = this.colors.edge
          context.fill()
          context.stroke()
          if (key === this.picked) ring = [bx, by]
        }
        if (ring !== undefined) {
          context.lineWidth = 2 * ratio
          context.strokeStyle = this.colors.picked
          context.beginPath()
          context.arc(ring[0], ring[1], 2 * half, 0, Math.PI * 2)
          context.stroke()
        }
        this.marks.dataset.bookEvents = String(placed.length)
        if (ring === undefined) delete this.marks.dataset.pickedEventAt
        else
          this.marks.dataset.pickedEventAt = `${ring[0] / ratio},${ring[1] / vertical}`
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "normal", renderer: () => this.renderer },
  ]

  constructor(
    private readonly colors: Colors,
    private readonly marks: HTMLElement
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

  show(events: ReadonlyArray<BookEvent>, picked: string | undefined) {
    this.events = events
    this.picked = picked
    this.attachedTo?.requestUpdate()
  }

  // The marks at the chart's current scale, in CSS pixels: each at its
  // minute's centre plus its share of the bar spacing for its second.
  private placed() {
    const attached = this.attachedTo
    if (attached === undefined) return []
    return this.events.flatMap((event) => {
      const at = DateTime.toEpochMillis(event.at)
      const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS
      const timeScale = attached.chart.timeScale()
      const centre = timeScale.timeToCoordinate((minute / 1000) as Time)
      const y = attached.series.priceToCoordinate(event.price)
      if (centre === null || y === null) return []
      const offset =
        ((at - minute) / MINUTE_MS) * timeScale.options().barSpacing
      const key = Effect.runSync(bookEventKey(event))
      return [{ event, key, x: centre + offset, y }]
    })
  }
}

// Marks `store`'s events on `candles` until the effect cleans up, redrawn at
// most once an animation frame when they, the picked one or the cursor
// change.
export function attachBookEventMarks(
  candles: ISeriesApi<SeriesType, Time>,
  store: BookEventStore,
  cursor: ReplayCursor | undefined,
  colors: Colors,
  marks: HTMLElement
) {
  const primitive = new BookEventMarks(colors, marks)
  candles.attachPrimitive(primitive)
  let frame = 0
  const redraw = () => {
    frame = 0
    const until = cursor?.state().at ?? Number.POSITIVE_INFINITY
    primitive.show(
      store
        .events()
        .filter((event) => DateTime.toEpochMillis(event.at) <= until),
      store.picked()
    )
  }
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(redraw)
  }
  redraw()
  const stopStore = store.subscribe(schedule)
  const stopCursor = cursor?.subscribe(schedule)
  return () => {
    stopStore()
    stopCursor?.()
    cancelAnimationFrame(frame)
    candles.detachPrimitive(primitive)
  }
}
