// The charts' order flow marks (spec apinrdw/kumora#605, "Order flow events:
// on the page"), on a fake chart drawing bars 10 px apart from x 50, a
// price's y 1,500 less the price.
import { StockCode, type Candle, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  ISeriesApi,
  ISeriesPrimitive,
  MouseEventParams,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import type { BookEventStore } from "@/components/market-live/book-event-store"
import { makeListenerStore } from "@/components/market-live/listener-store"
import type { ReplayCursor } from "@/components/market-live/replay-cursor"
import {
  attachOrderFlowMarks,
  type OrderFlowTipAt,
} from "@/components/market-live/order-flow-marks"

const code = StockCode.make("FOLK")
const seconds = (time: string) => Date.parse(`2026-11-17T${time}+07:00`) / 1000

const candle = (time: string, low: number, high: number): Candle => ({
  code,
  minute: DateTime.makeUnsafe(seconds(time) * 1000),
  open: low,
  high,
  low,
  close: high,
  volume: 1,
  value: low,
  buyValue: 0,
  sellValue: 0,
  frequency: 1,
})

const event = (time: string, side: "buy" | "sell"): OrderFlowEvent => ({
  kind: "exhaustion",
  code,
  at: DateTime.makeUnsafe(seconds(time) * 1000),
  side,
  price: 1000,
  lots: 900,
  peakLots: 2400,
  ticks: 1,
  widestTicks: 5,
})

const keyOf = (each: OrderFlowEvent) =>
  `FOLK|exhaustion|${each.side}|1000|${DateTime.toEpochMillis(each.at)}`

// Draws `events` once over `candles` on the candle chart, or the footprint
// chart's row, and hands back the marks' dataset, the tooltip store and the
// chart's crosshair and click handlers.
const drawn = (
  candles: ReadonlyArray<Candle>,
  events: ReadonlyArray<OrderFlowEvent>,
  picked: string | undefined,
  row = false,
  cursor?: ReplayCursor
) => {
  const bars = candles.map((each) => DateTime.toEpochMillis(each.minute) / 1000)
  let primitive: ISeriesPrimitive<Time> | undefined
  let hover: ((parameter: MouseEventParams<Time>) => void) | undefined
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (time: number) => {
        const index = bars.indexOf(time)
        return index < 0 ? null : 50 + 10 * index
      },
      logicalToCoordinate: (logical: number) => 50 + 10 * logical,
    }),
    subscribeCrosshairMove: (handler: typeof hover) => {
      hover = handler
    },
    unsubscribeCrosshairMove: () => {},
    chartElement: () => ({
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    }),
  } as unknown as IChartApi
  const series = {
    attachPrimitive: (each: ISeriesPrimitive<Time>) => {
      primitive = each
      each.attached?.({
        chart,
        series,
        requestUpdate: () => {},
      } as unknown as SeriesAttachedParameter<Time>)
    },
    detachPrimitive: () => {},
    priceToCoordinate: (price: number) => 1500 - price,
    data: () => bars.map((time) => ({ time })),
    getPane: () => ({ paneIndex: () => 0 }),
  } as unknown as ISeriesApi<SeriesType, Time>
  const store = {
    orderFlowEvents: () => events,
    picked: () => picked,
    subscribe: () => () => {},
  } as unknown as BookEventStore
  const marks = { dataset: {} } as HTMLElement
  const tip = Effect.runSync(
    makeListenerStore<OrderFlowTipAt | undefined>(undefined)
  )
  const attached = attachOrderFlowMarks({
    chart,
    series,
    store,
    candles: { candles: () => candles, subscribe: () => () => {} },
    cursor,
    colors: { buy: "", sell: "", edge: "", picked: "" },
    marks,
    tip,
    row,
  })
  const context = new Proxy({}, { get: () => () => {} })
  const renderer = primitive!
    .paneViews!()[0]!.renderer() as IPrimitivePaneRenderer | null
  renderer!.draw({
    useBitmapCoordinateSpace: (draw: (scope: unknown) => void) =>
      draw({ context, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  } as never)
  const pointAt = (x: number, y: number) =>
    ({ point: { x, y }, paneIndex: 0 }) as unknown as MouseEventParams<Time>
  return { dataset: marks.dataset, tip, hover: hover!, attached, pointAt }
}

const pickedAt = (dataset: DOMStringMap) =>
  (dataset.pickedOrderFlowAt ?? "").split(",").map(Number)

describe("the charts' order flow marks", () => {
  const candles = [candle("09:00:00", 990, 1000), candle("09:01:00", 980, 995)]

  it("puts ▲ above a buying-side event's candle and ▼ below a selling-side one's", () => {
    const buy = event("09:00:00", "buy")
    const sell = event("09:01:00", "sell")
    const above = drawn(candles, [buy, sell], keyOf(buy))
    expect(above.dataset.orderFlowMarks, "both events are marked").toBe("2")
    const [x, y] = pickedAt(above.dataset)
    expect(x, "on its minute's candle").toBe(50)
    expect(y, "above the high's y of 500").toBeLessThan(500)
    const [, below] = pickedAt(drawn(candles, [buy, sell], keyOf(sell)).dataset)
    expect(below, "below the low's y of 520").toBeGreaterThan(520)
  })

  it("puts the footprint chart's marks in one row at the top", () => {
    const buy = event("09:00:00", "buy")
    const sell = event("09:01:00", "sell")
    const [, first] = pickedAt(
      drawn(candles, [buy, sell], keyOf(buy), true).dataset
    )
    const [x, second] = pickedAt(
      drawn(candles, [buy, sell], keyOf(sell), true).dataset
    )
    expect(x).toBe(60)
    expect(second).toBe(first)
    expect(first).toBeLessThan(20)
  })

  it("shows a mark's tooltip on hover, and pins it on a tap", () => {
    const buy = event("09:00:00", "buy")
    const chart = drawn(candles, [buy], keyOf(buy))
    const [x, y] = pickedAt(chart.dataset)
    chart.hover(chart.pointAt(x!, y!))
    expect(chart.tip.get()).toMatchObject({ key: keyOf(buy), pinned: false })
    chart.hover(chart.pointAt(x! + 40, y!))
    expect(chart.tip.get(), "off the mark, it hides").toBeUndefined()
    expect(chart.attached.click(chart.pointAt(x!, y! + 2))).toBe(true)
    expect(chart.tip.get()).toMatchObject({ key: keyOf(buy), pinned: true })
    chart.hover(chart.pointAt(x! + 40, y!))
    expect(chart.tip.get(), "a hover leaves a pinned one").toBeDefined()
    expect(chart.attached.click(chart.pointAt(x! + 40, y!))).toBe(false)
  })

  it("hides a mark's tooltip once the cursor moves back before its event", () => {
    const buy = event("09:00:00", "buy")
    let at = seconds("09:05:00") * 1000
    let moved = () => {}
    const cursor = {
      state: () => ({ at }),
      subscribe: (listener: () => void) => {
        moved = listener
        return () => {}
      },
    } as unknown as ReplayCursor
    const frames = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (draw) => {
      draw(0)
      return 1
    }
    try {
      const chart = drawn(candles, [buy], keyOf(buy), false, cursor)
      const [x, y] = pickedAt(chart.dataset)
      chart.attached.click(chart.pointAt(x!, y!))
      expect(chart.tip.get()).toBeDefined()
      at = seconds("09:00:30") * 1000
      moved()
      expect(chart.tip.get(), "its minute hadn't closed").toBeUndefined()
    } finally {
      globalThis.requestAnimationFrame = frames
    }
  })
})
