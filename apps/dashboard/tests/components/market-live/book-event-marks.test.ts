// The candle chart's book event marks (spec apinrdw/kumora#517, "Book
// events"), on a fake chart drawing bars 10 px apart from x 50.
import { StockCode, type BookEvent } from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type {
  IPrimitivePaneRenderer,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts"

import { attachBookEventMarks } from "@/components/market-live/book-event-marks"
import type { BookEventStore } from "@/components/market-live/book-event-store"

const seconds = (time: string) => Date.parse(`2026-11-17T${time}+07:00`) / 1000

const appeared = (time: string): BookEvent => ({
  kind: "appeared",
  code: StockCode.make("FOLK"),
  at: DateTime.makeUnsafe(seconds(time) * 1000),
  side: "bid",
  price: 1000,
  lots: 6000,
  orders: 2,
  ticks: 2,
})

// Draws `events` once on a chart whose bars are `bars`, returning the
// marks' dataset.
const drawn = (
  bars: ReadonlyArray<number>,
  events: ReadonlyArray<BookEvent>,
  picked: string
) => {
  let primitive: ISeriesPrimitive<Time> | undefined
  const attached = {
    chart: {
      timeScale: () => ({
        options: () => ({ barSpacing: 10 }),
        timeToCoordinate: (time: number) => {
          const index = bars.indexOf(time)
          return index < 0 ? null : 50 + 10 * index
        },
        logicalToCoordinate: (logical: number) => 50 + 10 * logical,
      }),
    },
    series: {
      priceToCoordinate: () => 200,
      data: () => bars.map((time) => ({ time })),
    },
    requestUpdate: () => {},
  } as unknown as SeriesAttachedParameter<Time>
  const candles = {
    attachPrimitive: (each: ISeriesPrimitive<Time>) => {
      primitive = each
      each.attached?.(attached)
    },
  } as unknown as ISeriesApi<SeriesType, Time>
  const store = {
    events: () => events,
    picked: () => picked,
    subscribe: () => () => {},
  } as unknown as BookEventStore
  const marks = { dataset: {} } as HTMLElement
  attachBookEventMarks(
    candles,
    store,
    undefined,
    { bid: "", offer: "", edge: "", picked: "" },
    marks
  )
  const context = new Proxy({}, { get: () => () => {} })
  const renderer = primitive!
    .paneViews!()[0]!.renderer() as IPrimitivePaneRenderer | null
  renderer!.draw({
    useBitmapCoordinateSpace: (draw: (scope: unknown) => void) =>
      draw({ context, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  } as never)
  return marks.dataset
}

describe("the candle chart's book event marks", () => {
  it("mark an event in a minute with no candle between its neighbours", () => {
    // Candles at 09:00 and 09:02; a wall appears at 09:01:30, with no trade
    // that minute.
    const dataset = drawn(
      [seconds("09:00:00"), seconds("09:02:00")],
      [appeared("09:01:30"), appeared("09:02:30")],
      `FOLK|appeared|bid|1000|${seconds("09:01:30") * 1000}`
    )
    expect(dataset.bookEvents, "both events are marked").toBe("2")
    const [x] = (dataset.pickedEventAt ?? "").split(",").map(Number)
    expect(x, "the 09:01 mark sits between the two candles").toBeGreaterThan(50)
    expect(x).toBeLessThan(60)
  })
})
