import {
  StockCode,
  TradeNumber,
  WibDate,
  marketPhases,
  type HeatSlice,
  type Sweep,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import type {
  IPrimitivePaneRenderer,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesType,
  Time,
} from "lightweight-charts"
import { vi } from "vitest"

import { attachBookHeatmap } from "@/components/market-live/book-heatmap"
import { makeHeatmapStore } from "@/components/market-live/heatmap-store"
import { makeReplayCursor } from "@/components/market-live/replay-cursor"
import { cursorLogical, replayDay } from "@/lib/replay"
import { bubbleOffset } from "@/lib/sweeps"

const UNTR = StockCode.make("UNTR")
const DAY = WibDate.make("2026-11-09")
const at = (wib: string) => Date.parse(`${DAY}T${wib}+07:00`)
const seconds = (wib: string) => at(wib) / 1000

// Px a minute, at one bitmap px a CSS px.
const SPACING = 60

// The canvas as the heatmap draws on it: a path keeps the left edge of each
// rectangle, and a context the left edge of each one filled on it, a copied
// canvas's shifted to where it was copied.
class Path {
  readonly lefts: Array<number> = []
  rect(left: number) {
    this.lefts.push(left)
  }
}
class Context {
  fillStyle = ""
  globalAlpha = 1
  readonly lefts: Array<number> = []
  fill(path: Path) {
    this.lefts.push(...path.lefts)
  }
  drawImage(canvas: Canvas, left: number) {
    this.lefts.push(...canvas.context.lefts.map((x) => left + x))
  }
}
class Canvas {
  static made = 0
  readonly context = new Context()
  constructor() {
    Canvas.made++
  }
  getContext() {
    return this.context
  }
}

beforeEach(() => {
  Canvas.made = 0
  vi.stubGlobal("Path2D", Path)
  vi.stubGlobal("OffscreenCanvas", Canvas)
  vi.stubGlobal("cancelAnimationFrame", () => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const slice = (wib: string): HeatSlice => ({
  at: DateTime.makeUnsafe(at(wib)),
  levels: [[8_000, 50, 0]],
})

// The heatmap of a recorded day's `slices` with its cursor at `cursorAt`, on
// a chart that draws the minutes of `centres` (WIB minute to its centre, px)
// and no others, as Lightweight Charts 5.2.1 drives a series primitive.
// `draw` paints one frame and returns the left edge of each slice shaded.
const heatmapOf = Effect.fnUntraced(function* (
  slices: ReadonlyArray<HeatSlice>,
  centres: Readonly<Record<string, number>>,
  cursorAt: string
) {
  const store = yield* makeHeatmapStore(UNTR, DAY)
  store.seed({ code: UNTR, through: DateTime.makeUnsafe(at("16:35")), slices })
  const cursor = yield* makeReplayCursor(
    yield* replayDay(DAY, yield* marketPhases(DAY))
  )
  cursor.seek(at(cursorAt))
  const byTime = new Map(
    Object.entries(centres).map(([wib, centre]) => [seconds(wib), centre])
  )
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: SPACING }),
      timeToCoordinate: (time: number) => byTime.get(time) ?? null,
    }),
  }
  let primitive: ISeriesPrimitive<Time> | undefined
  const series = {
    priceToCoordinate: (price: number) => 10_000 - price,
    attachPrimitive: (attached: ISeriesPrimitive<Time>) => {
      primitive = attached
      attached.attached?.({ chart, series, requestUpdate: () => {} } as never)
    },
    detachPrimitive: () => {},
  }
  let shaded = 0
  const detach = attachBookHeatmap(
    series as unknown as ISeriesApi<SeriesType, Time>,
    store,
    cursor,
    { bid: "#00ff00", offer: "#ff0000" },
    (count) => {
      shaded = count
    }
  )
  return {
    draw: () => {
      const context = new Context()
      for (const view of primitive?.paneViews?.() ?? [])
        view.renderer()?.draw({
          useBitmapCoordinateSpace: (
            paint: (scope: Record<string, unknown>) => void
          ) =>
            paint({
              context,
              bitmapSize: { width: 600, height: 400 },
              horizontalPixelRatio: 1,
              verticalPixelRatio: 1,
            }),
        } as unknown as Parameters<IPrimitivePaneRenderer["draw"]>[0])
      return context.lefts.sort((a, b) => a - b)
    },
    shaded: () => shaded,
    detach,
  }
})

const sweepAt = (wib: string): Sweep => ({
  side: "buy",
  firstTrade: TradeNumber.make("1"),
  time: DateTime.makeUnsafe(at(wib)),
  first: 8_000,
  last: 8_000,
  lots: 1,
  value: 800_000,
  trades: 1,
})

describe("the book heatmap on chart 1", () => {
  it.effect(
    "starts a slice where the cursor line and a sweep bubble of its second sit",
    () =>
      Effect.gen(function* () {
        // 09:00 is a past minute, copied from its canvas; 09:01 is the
        // cursor's, painted directly.
        const heatmap = yield* heatmapOf(
          [slice("09:00:30"), slice("09:01:30")],
          { "09:00": 100, "09:01": 160 },
          "09:01:59"
        )
        expect(heatmap.draw()).toEqual([130, 190])
        heatmap.detach()
        // The cursor line: the first bar's centre plus its logical position
        // in bars (cursor-line.ts).
        const times = [seconds("09:00"), seconds("09:01")]
        expect(
          100 + (yield* cursorLogical(times, at("09:00:30"))) * SPACING
        ).toBe(130)
        expect(
          100 + (yield* cursorLogical(times, at("09:01:30"))) * SPACING
        ).toBe(190)
        // A sweep bubble: its minute's centre plus its offset
        // (sweep-bubbles.ts).
        expect(100 + (yield* bubbleOffset(sweepAt("09:00:30"), SPACING))).toBe(
          130
        )
        expect(160 + (yield* bubbleOffset(sweepAt("09:01:30"), SPACING))).toBe(
          190
        )
      })
  )

  it.effect(
    "shades no slice and keeps no canvas for a minute the chart does not draw",
    () =>
      Effect.gen(function* () {
        // The book rests through lunch, whose minutes have no candle and no
        // gap whitespace. 13:30 is the cursor's minute, painted directly.
        const heatmap = yield* heatmapOf(
          [
            slice("11:59:00"),
            slice("12:00:00"),
            slice("12:01:00"),
            slice("13:30:00"),
          ],
          { "11:59": 100, "13:30": 160 },
          "13:30:30"
        )
        expect({
          lefts: heatmap.draw(),
          shaded: heatmap.shaded(),
          canvases: Canvas.made,
        }).toEqual({ lefts: [100, 160], shaded: 2, canvases: 1 })
        heatmap.detach()
      })
  )
})
