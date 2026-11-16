// Chart 1's sweep bubbles (spec apinrdw/kumora#263, "Chart 1"), loaded with
// Lightweight Charts in chart-canvas.tsx's browser-only chunk.
import type { Sweep, TradeNumber } from "@workspace/relay"
import { Side } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  MouseEventParams,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import {
  bubbleOffset,
  bubbleRadius,
  isBigSweep,
  sweepMinute,
  sweepPrice,
  type KeptSweep,
} from "@/lib/sweeps"

import type { ReplayCursor } from "./replay-cursor"
import type { SweepStore } from "./sweep-store"

// The aggressor sides a bubble is drawn for: an auction match has none.
type BubbleSide = Exclude<typeof Side.Type, "none">
const BUBBLE_SIDES = Side.literals.filter(
  (side): side is BubbleSide => side !== "none"
)

// One bubble, worked out when the sweeps change, so a draw only places it.
interface Bubble {
  // Its sweep's first trade's number.
  readonly id: TradeNumber
  readonly side: BubbleSide
  readonly time: number
  // Its sweep's own lots: the picked broker's, or the whole sweep's.
  readonly lots: number
  readonly price: number
  readonly radius: number
  readonly big: boolean
  // The bubble's offset from its minute's centre at a bar spacing of 1.
  readonly offset: number
}

export interface BubbleColors {
  readonly buy: string
  readonly sell: string
  readonly big: string
  readonly selected: string
}

// A sweep's bubble id in the chart's hit test.
const HIT_PREFIX = "sweep:"

// Each minute's bubbles, one per shown sweep or piece, largest first, so
// small ones draw on top, a split sweep's pieces in one second included.
export const bubblesOf = Effect.fnUntraced(function* (
  sweeps: ReadonlyArray<KeptSweep>
) {
  const byMinute = new Map<number, Array<Bubble>>()
  for (const sweep of sweeps) {
    // An auction match forms no sweep and gets no bubble.
    if (sweep.side === "none") continue
    const minute = (yield* sweepMinute(sweep)) / 1000
    let bubbles = byMinute.get(minute)
    if (bubbles === undefined) {
      bubbles = []
      byMinute.set(minute, bubbles)
    }
    bubbles.push({
      id: sweep.firstTrade,
      side: sweep.side,
      time: DateTime.toEpochMillis(sweep.time),
      lots: sweep.own,
      price: yield* sweepPrice(sweep),
      radius: yield* bubbleRadius(sweep.own),
      big: yield* isBigSweep(sweep),
      offset: yield* bubbleOffset(sweep, 1),
    })
  }
  for (const bubbles of byMinute.values())
    bubbles.sort((a, b) => b.lots - a.lots)
  return byMinute
})

// Draws each shown sweep as a bubble at its average price, x at its minute's
// centre plus its second: green buy, red sell, area by own lots, an amber ring on
// a big trade, and a ring and guide on the selected one. A bubble is a hit
// target, so a click picks its sweep and a hover shows its tooltip. The
// last draw's bubble count and selection, with the selected bubble's centre
// in CSS px, go on `marks` for the page e2e.
class SweepBubbles implements ISeriesPrimitive<Time> {
  private byMinute = new Map<number, Array<Bubble>>()
  private threshold = 0
  private at = Number.POSITIVE_INFINITY
  private selected: TradeNumber | undefined
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const placed = this.placed()
        const ratio = scope.horizontalPixelRatio
        const context = scope.context
        const paths: Record<BubbleSide, Path2D> = {
          buy: new Path2D(),
          sell: new Path2D(),
        }
        const rings = new Path2D()
        let ring: readonly [number, number, number] | undefined
        for (const { bubble, x, y } of placed) {
          const bx = x * ratio
          const by = y * scope.verticalPixelRatio
          const r = bubble.radius * ratio
          paths[bubble.side].moveTo(bx + r, by)
          paths[bubble.side].arc(bx, by, r, 0, Math.PI * 2)
          if (bubble.big) {
            rings.moveTo(bx + r + 2 * ratio, by)
            rings.arc(bx, by, r + 2 * ratio, 0, Math.PI * 2)
          }
          if (bubble.id === this.selected) ring = [bx, by, r]
        }
        context.lineWidth = Math.max(1, ratio)
        for (const side of BUBBLE_SIDES) {
          context.fillStyle = `${this.colors[side]}61`
          context.fill(paths[side])
          context.strokeStyle = `${this.colors[side]}e6`
          context.stroke(paths[side])
        }
        context.lineWidth = 1.5 * ratio
        context.strokeStyle = this.colors.big
        context.stroke(rings)
        if (ring !== undefined) {
          const [x, y, r] = ring
          context.lineWidth = 2.5 * ratio
          context.strokeStyle = this.colors.selected
          context.beginPath()
          context.arc(x, y, r + 5 * ratio, 0, Math.PI * 2)
          context.stroke()
          context.setLineDash([3 * ratio, 3 * ratio])
          context.lineWidth = ratio
          context.beginPath()
          context.moveTo(x, 0)
          context.lineTo(x, y - r - 6 * ratio)
          context.moveTo(x, y + r + 6 * ratio)
          context.lineTo(x, scope.bitmapSize.height)
          context.stroke()
          context.setLineDash([])
        }
        this.marks.dataset.bubbles = String(placed.length)
        if (ring === undefined) {
          delete this.marks.dataset.ringedSweep
          delete this.marks.dataset.ringedAt
        } else {
          this.marks.dataset.ringedSweep = this.selected
          this.marks.dataset.ringedAt = `${ring[0] / ratio},${ring[1] / scope.verticalPixelRatio}`
        }
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "normal", renderer: () => this.renderer },
  ]

  constructor(
    private readonly colors: BubbleColors,
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

  show(options: {
    readonly byMinute?: Map<number, Array<Bubble>>
    readonly threshold: number
    readonly at: number
    readonly selected: TradeNumber | undefined
  }) {
    if (options.byMinute !== undefined) this.byMinute = options.byMinute
    this.threshold = options.threshold
    this.at = options.at
    this.selected = options.selected
    this.attachedTo?.requestUpdate()
  }

  // The bubbles shown at the chart's current scale, in CSS pixels.
  private placed() {
    const attached = this.attachedTo
    if (attached === undefined) return []
    const timeScale = attached.chart.timeScale()
    const spacing = timeScale.options().barSpacing
    const placed: Array<{ bubble: Bubble; x: number; y: number }> = []
    for (const [minute, bubbles] of this.byMinute) {
      const centre = timeScale.timeToCoordinate(minute as Time)
      if (centre === null) continue
      for (const bubble of bubbles) {
        if (bubble.time > this.at || bubble.lots < this.threshold) continue
        const y = attached.series.priceToCoordinate(bubble.price)
        if (y === null) continue
        placed.push({ bubble, x: centre + bubble.offset * spacing, y })
      }
    }
    return placed
  }

  // Where `sweep`'s bubble sits on the pane, in CSS pixels, drawn or not;
  // none off the chart.
  centreOf(sweep: Sweep) {
    const attached = this.attachedTo
    if (attached === undefined) return undefined
    const timeScale = attached.chart.timeScale()
    const centre = timeScale.timeToCoordinate(
      (Effect.runSync(sweepMinute(sweep)) / 1000) as Time
    )
    const y = attached.series.priceToCoordinate(
      Effect.runSync(sweepPrice(sweep))
    )
    if (centre === null || y === null) return undefined
    const offset = Effect.runSync(
      bubbleOffset(sweep, timeScale.options().barSpacing)
    )
    return { x: centre + offset, y }
  }

  // The shown bubble nearest a point of the pane, among those it is on.
  nearest(x: number, y: number) {
    let best: { id: TradeNumber; distance: number } | undefined
    for (const placed of this.placed()) {
      const distance = Math.hypot(placed.x - x, placed.y - y)
      if (distance > placed.bubble.radius + 2) continue
      if (best === undefined || distance < best.distance)
        best = { id: placed.bubble.id, distance }
    }
    return best
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const best = this.nearest(x, y)
    return best === undefined
      ? null
      : {
          externalId: `${HIT_PREFIX}${best.id}`,
          zOrder: "normal",
          distance: best.distance,
          hitTestPriority: 2,
          cursorStyle: "pointer",
        }
  }
}

// Puts the store's kept sweeps on chart 1's candle series as bubbles, redrawn at
// most once a frame when the kept sweeps, the top-N or the cursor change. A sweep
// picked in the log scrolls chart 1 to its minute, keeping the zoom unless it
// is wider than an hour. Returns `click`, which chart 1's click handler calls
// first, and the cleanup.
export function attachSweepBubbles({
  chart,
  series,
  store,
  cursor,
  colors,
  marks,
}: {
  chart: IChartApi
  series: ISeriesApi<SeriesType>
  store: SweepStore
  cursor: ReplayCursor | undefined
  colors: BubbleColors
  marks: HTMLElement
}) {
  const bubbles = new SweepBubbles(colors, marks)
  series.attachPrimitive(bubbles)
  let shownSweeps: ReadonlyArray<KeptSweep> | undefined
  let frame = 0
  const redraw = () => {
    frame = 0
    const sweeps = store.kept()
    const at =
      cursor === undefined ? Number.POSITIVE_INFINITY : cursor.state().at
    const byMinute =
      sweeps === shownSweeps ? undefined : Effect.runSync(bubblesOf(sweeps))
    shownSweeps = sweeps
    bubbles.show({
      ...(byMinute === undefined ? {} : { byMinute }),
      threshold: store.threshold(at).lots,
      at,
      selected: store.selected(),
    })
  }
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(redraw)
  }
  redraw()
  const jump = (minute: number) => {
    const timeScale = chart.timeScale()
    const index = timeScale.timeToIndex((minute / 1000) as Time, true)
    const range = timeScale.getVisibleLogicalRange()
    if (index === null || range === null) return
    const width = range.to - range.from > 60 ? 30 : range.to - range.from
    timeScale.setVisibleLogicalRange({
      from: (index - width / 2) as Logical,
      to: (index + width / 2) as Logical,
    })
  }
  // The place of the pin this layer last placed: its sweep's id, time and
  // average price, which set its bubble. A pinned tooltip whose sweep
  // split, into a piece of another id or one keeping its id at another
  // price, goes to that piece's bubble, as a click on it would pin it.
  let placed: string | undefined
  const placeOf = (id: TradeNumber) => {
    const sweep = store.sweeps().find((held) => held.firstTrade === id)
    const key =
      sweep &&
      `${id} ${DateTime.toEpochMillis(sweep.time)} ${Effect.runSync(sweepPrice(sweep))}`
    return { sweep, key }
  }
  const repin = () => {
    const shown = store.tip.get()
    if (!shown?.pinned || shown.from !== "chart") return
    const { sweep, key } = placeOf(shown.id)
    if (key === placed) return
    placed = key
    const centre = sweep && bubbles.centreOf(sweep)
    if (centre === undefined) return
    const box = chart.chartElement().getBoundingClientRect()
    store.tip.set({ ...shown, x: box.left + centre.x, y: box.top + centre.y })
  }
  const stopStore = store.subscribe((change) => {
    if (change._tag === "Selected" && change.from === "log") jump(change.minute)
    if (change._tag === "Brokers") repin()
    schedule()
  })
  const stopCursor = cursor?.subscribe(schedule)
  // The tooltip of the bubble at the pointer, or none once it is on no
  // bubble; a log cell's tooltip, and a pinned one, are left alone.
  // `pin` pins it, for a click or a tap.
  // Decision: the bubbles' own hit test finds the bubble, since a tap's
  // click carries no hovered object (the library hit-tests where the
  // crosshair was, and a tap moved none there). Its point is pane-local, so
  // a point in another pane (chart 1's volume) is on no bubble.
  const tip = (parameter: MouseEventParams<Time>, pin = false) => {
    const point =
      parameter.paneIndex === series.getPane().paneIndex()
        ? parameter.point
        : undefined
    const id = point && bubbles.nearest(point.x, point.y)?.id
    const shown = store.tip.get()
    if (!pin && shown?.pinned) return id
    if (id === undefined || point === undefined) {
      if (shown?.from === "chart") store.tip.set(undefined)
      return id
    }
    const box = chart.chartElement().getBoundingClientRect()
    if (pin) placed = placeOf(id).key
    store.tip.set({
      id,
      x: box.left + point.x,
      y: box.top + point.y,
      from: "chart",
      pinned: pin,
    })
    return id
  }
  chart.subscribeCrosshairMove(tip)
  return {
    // A click or a tap on a bubble selects its sweep and shows its tooltip
    // (a tap has no hover); says whether it was on one.
    click: (parameter: MouseEventParams<Time>) => {
      const id = tip(parameter, true)
      if (id !== undefined) store.select(id, "chart")
      return id !== undefined
    },
    detach: () => {
      cancelAnimationFrame(frame)
      chart.unsubscribeCrosshairMove(tip)
      stopStore()
      stopCursor?.()
      series.detachPrimitive(bubbles)
    },
  }
}
