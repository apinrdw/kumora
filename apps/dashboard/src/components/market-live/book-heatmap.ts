// The candle chart's book heatmap (spec apinrdw/kumora#263, "Chart 1"): a
// series primitive on the candles that shades each 10-second slice's resting
// lots behind them, bid in the up colour and offer in the down colour. Loaded
// only with chart-canvas.tsx, in the browser.
import { HEAT_SLICE_MS, type HeatSlice, MINUTE_MS } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts"

import { idxTick } from "@/lib/footprint"

import type { HeatmapStore } from "./heatmap-store"
import type { ReplayCursor } from "./replay-cursor"

const SLICES = MINUTE_MS / HEAT_SLICE_MS
// Shades a side, from faint to full: opacity by the square root of lots.
const BUCKETS = 8
const MAX_ALPHA = 0.6
// The lots that shade fully: the day's 98th percentile, so one huge order
// doesn't wash out the rest.
const FULL_PERCENTILE = 0.98

// One price of one slice, with its IDX tick: its row is one tick tall.
interface Cell {
  readonly price: number
  readonly tick: number
  readonly bid: number
  readonly offer: number
}

// One minute's slices, by their index in the minute, and the store's slices
// they came from: the store keeps a settled slice the same object.
interface Minute {
  readonly minute: number
  readonly time: UTCTimestamp
  readonly source: ReadonlyArray<HeatSlice>
  readonly slices: ReadonlyArray<{
    readonly index: number
    readonly cells: ReadonlyArray<Cell>
  }>
}

const sameSource = (a: ReadonlyArray<HeatSlice>, b: ReadonlyArray<HeatSlice>) =>
  Effect.sync(
    () => a.length === b.length && a.every((slice, at) => slice === b[at])
  )

// One minute's slices, each level with its tick.
const minuteOf = Effect.fnUntraced(function* (
  minute: number,
  source: ReadonlyArray<HeatSlice>
) {
  const slices: Array<Minute["slices"][number]> = []
  for (const slice of source) {
    const cells: Array<Cell> = []
    for (const [price, bid, offer] of slice.levels)
      cells.push({ price, tick: yield* idxTick(price), bid, offer })
    slices.push({
      index: (DateTime.toEpochMillis(slice.at) - minute) / HEAT_SLICE_MS,
      cells,
    })
  }
  return {
    minute,
    time: (minute / 1000) as UTCTimestamp,
    source,
    slices,
  } satisfies Minute
})

// The slices by minute, ascending, each minute whose slices are the ones
// `before` held kept as it was.
const minutesOf = Effect.fnUntraced(function* (
  slices: ReadonlyArray<HeatSlice>,
  before: ReadonlyMap<number, Minute>
) {
  const byMinute = new Map<number, Array<HeatSlice>>()
  for (const slice of slices) {
    const minute =
      Math.floor(DateTime.toEpochMillis(slice.at) / MINUTE_MS) * MINUTE_MS
    const held = byMinute.get(minute) ?? []
    held.push(slice)
    byMinute.set(minute, held)
  }
  const minutes: Array<Minute> = []
  for (const [minute, source] of byMinute) {
    const kept = before.get(minute)
    minutes.push(
      kept !== undefined && (yield* sameSource(kept.source, source))
        ? kept
        : yield* minuteOf(minute, source)
    )
  }
  return minutes.sort((a, b) => a.minute - b.minute)
})

// The lots that shade fully, rounded to a quarter power of 2 so a new lot
// seldom moves it.
const fullOf = Effect.fnUntraced(function* (minutes: ReadonlyArray<Minute>) {
  const lots: Array<number> = []
  for (const minute of minutes)
    for (const slice of minute.slices)
      for (const cell of slice.cells) {
        if (cell.bid > 0) lots.push(cell.bid)
        if (cell.offer > 0) lots.push(cell.offer)
      }
  lots.sort((a, b) => a - b)
  const full = lots[Math.floor((lots.length - 1) * FULL_PERCENTILE)] ?? 1
  return 2 ** (Math.round(Math.log2(Math.max(1, full)) * 4) / 4)
})

// What a minute is drawn with: the bitmap's scale and the price mapping.
interface Frame {
  readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  readonly series: ISeriesApi<SeriesType, Time>
  readonly barSpacing: number
  readonly ratio: number
  readonly vertical: number
  readonly full: number
}

// Each past minute is painted once into an offscreen canvas and
// copied while the bar spacing, pixel ratio and price mapping hold; only the
// current minute (newest live, the cursor's when recorded) paints each frame.
// Minutes out of view drop their canvas, so the cache holds about one chart's
// pixels. See spec apinrdw/kumora#263, "Chart 1".
class BookHeatmap implements ISeriesPrimitive<Time> {
  private minutes: ReadonlyArray<Minute> = []
  private full = 1
  // Slices at or after it are not drawn: a recorded day's cursor.
  private until = Number.POSITIVE_INFINITY
  private cache = new Map<number, OffscreenCanvas>()
  private cacheKey = ""
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => this.draw(scope)),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "bottom", renderer: () => this.renderer },
  ]

  constructor(
    private readonly colors: { readonly bid: string; readonly offer: string },
    // Told how many slices the last draw shaded.
    private readonly drawn: (slices: number) => void
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

  setSlices(slices: ReadonlyArray<HeatSlice>, until: number) {
    const before = new Map(
      this.minutes.map((minute) => [minute.minute, minute])
    )
    const minutes = Effect.runSync(minutesOf(slices, before))
    // The shading's scale is worked out again only when a minute is added,
    // not as the current one changes.
    if (minutes.length !== this.minutes.length)
      this.full = Effect.runSync(fullOf(minutes))
    for (const minute of minutes)
      if (before.get(minute.minute) !== minute) this.cache.delete(minute.minute)
    this.minutes = minutes
    this.until = until
    this.attachedTo?.requestUpdate()
  }

  // Fills a minute's cells into `frame.context`, its left edge at `left`
  // (bitmap px): one path per side and shade.
  private fill(frame: Frame, minute: Minute, left: number) {
    const paths = {
      bid: Array.from({ length: BUCKETS }, () => new Path2D()),
      offer: Array.from({ length: BUCKETS }, () => new Path2D()),
    }
    const width = (frame.barSpacing / SLICES) * frame.ratio
    for (const slice of minute.slices) {
      const x = Math.round(left + slice.index * width)
      const w = Math.max(1, Math.round(left + (slice.index + 1) * width) - x)
      for (const cell of slice.cells) {
        const y = frame.series.priceToCoordinate(cell.price)
        const above = frame.series.priceToCoordinate(cell.price + cell.tick)
        if (y === null || above === null) continue
        const h = Math.max(1, Math.abs(y - above) * frame.vertical)
        const top = Math.round(y * frame.vertical - h / 2)
        for (const side of ["bid", "offer"] as const) {
          if (cell[side] <= 0) continue
          const shade = Math.sqrt(Math.min(1, cell[side] / frame.full))
          const bucket = Math.min(BUCKETS - 1, Math.floor(shade * BUCKETS))
          paths[side][bucket]!.rect(x, top, w, Math.max(1, Math.round(h)))
        }
      }
    }
    return paths
  }

  // Shades a minute's cells, side by side and shade by shade.
  private paint(frame: Frame, minute: Minute, left: number) {
    const paths = this.fill(frame, minute, left)
    for (const side of ["bid", "offer"] as const) {
      frame.context.fillStyle = this.colors[side]
      paths[side].forEach((path, bucket) => {
        frame.context.globalAlpha = ((bucket + 1) / BUCKETS) * MAX_ALPHA
        frame.context.fill(path)
      })
    }
    frame.context.globalAlpha = 1
  }

  // Drops the cached minutes when what they were painted with changed.
  private keep(key: string) {
    if (key === this.cacheKey) return
    this.cache.clear()
    this.cacheKey = key
  }

  // Shades a past minute from its cached canvas, painting it first if none.
  private copy(frame: Frame, minute: Minute, left: number, height: number) {
    let canvas = this.cache.get(minute.minute)
    if (canvas === undefined) {
      canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(frame.barSpacing * frame.ratio) + 1),
        height
      )
      const context = canvas.getContext("2d")
      if (context === null) return
      this.paint({ ...frame, context }, minute, 0)
      this.cache.set(minute.minute, canvas)
    }
    frame.context.drawImage(canvas, left, 0)
  }

  // Shades the current minute directly, its slices before `until` only.
  // Returns how many it shaded.
  private paintCurrent(frame: Frame, minute: Minute, left: number) {
    const slices = minute.slices.filter(
      (slice) => minute.minute + slice.index * HEAT_SLICE_MS < this.until
    )
    this.paint(frame, { ...minute, slices }, left)
    return slices.length
  }

  // Shades every minute in view up to the current one, and drops the cached
  // canvases of the rest. Returns how many slices it shaded.
  private shadeMinutes(
    frame: Frame,
    xOf: (time: UTCTimestamp) => number | null,
    bitmap: { readonly width: number; readonly height: number }
  ) {
    const current = Math.min(
      this.minutes.at(-1)?.minute ?? 0,
      Math.floor(this.until / MINUTE_MS) * MINUTE_MS
    )
    const width = frame.barSpacing * frame.ratio
    const seen = new Set<number>()
    let shaded = 0
    for (const minute of this.minutes) {
      if (minute.minute > current) break
      // Decision: a candle-less minute's mark sits where the cursor line would
      // (apps/dashboard/docs/adr/0024-chart-marks-in-an-empty-minute-sit-where-the-cursor-would.md)
      const x = xOf(minute.time)
      // No coordinate: the chart does not draw the minute (it has no candle
      // and no gap whitespace), so it is not in view and gets no canvas.
      if (x === null) continue
      const left = Math.round(x * frame.ratio)
      if (left + width < 0 || left > bitmap.width) continue
      seen.add(minute.minute)
      if (minute.minute === current)
        shaded += this.paintCurrent(frame, minute, left)
      else {
        shaded += minute.slices.length
        this.copy(frame, minute, left, bitmap.height)
      }
    }
    for (const minute of this.cache.keys())
      if (!seen.has(minute)) this.cache.delete(minute)
    return shaded
  }

  private draw(scope: {
    readonly context: CanvasRenderingContext2D
    readonly bitmapSize: { readonly width: number; readonly height: number }
    readonly horizontalPixelRatio: number
    readonly verticalPixelRatio: number
  }) {
    const attached = this.attachedTo
    if (attached === undefined) return
    const timeScale = attached.chart.timeScale()
    const { series } = attached
    const barSpacing = timeScale.options().barSpacing
    const ratio = scope.horizontalPixelRatio
    this.keep(
      [
        barSpacing,
        ratio,
        scope.verticalPixelRatio,
        scope.bitmapSize.height,
        series.priceToCoordinate(0),
        series.priceToCoordinate(10_000),
        this.full,
      ].join("|")
    )
    const frame: Frame = {
      context: scope.context,
      series,
      barSpacing,
      ratio,
      vertical: scope.verticalPixelRatio,
      full: this.full,
    }
    const shaded = this.shadeMinutes(
      frame,
      (time) => timeScale.timeToCoordinate(time),
      scope.bitmapSize
    )
    this.drawn(shaded)
  }
}

// Shades `store`'s slices behind `candles` until the effect cleans up: each
// change at most once an animation frame, a recorded day's up to its cursor,
// a live day's current slice rebuilt every second. `drawn` hears how many
// slices each draw shaded.
export function attachBookHeatmap(
  candles: ISeriesApi<SeriesType, Time>,
  store: HeatmapStore,
  cursor: ReplayCursor | undefined,
  colors: { readonly bid: string; readonly offer: string },
  drawn: (slices: number) => void
) {
  const heatmap = new BookHeatmap(colors, drawn)
  candles.attachPrimitive(heatmap)
  const until = () => cursor?.state().at ?? Number.POSITIVE_INFINITY
  let frame = 0
  const shadeNow = () => {
    frame = 0
    heatmap.setSlices(store.slices(), until())
  }
  const shadeNextFrame = () => {
    if (frame === 0) frame = requestAnimationFrame(shadeNow)
  }
  shadeNow()
  const stopStore = store.subscribe(shadeNextFrame)
  // The cursor moved to another slice.
  let slice = Math.floor(until() / HEAT_SLICE_MS)
  const stopCursor = cursor?.subscribe(() => {
    const next = Math.floor(until() / HEAT_SLICE_MS)
    if (next === slice) return
    slice = next
    shadeNextFrame()
  })
  const timer = cursor === undefined ? setInterval(store.tick, 1_000) : 0
  return () => {
    stopStore()
    stopCursor?.()
    clearInterval(timer)
    cancelAnimationFrame(frame)
    candles.detachPrimitive(heatmap)
  }
}
