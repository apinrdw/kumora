// @vitest-environment happy-dom
import { StockCode, type Candle, type RelayGap } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"

import { makeCandleStore } from "@/components/market-live/candle-store"
import ChartCanvas from "@/components/market-live/chart-canvas"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Lightweight Charts draws on a canvas happy-dom lacks. This stands in with
// its data layer's two update rules (lightweight-charts 5.2.1,
// DataLayer.updateSeriesData): a bar older than the series' last bar,
// whitespace included, needs the historical flag, and the historical flag
// needs a bar at that time.
const { series, FakeSeries } = vi.hoisted(() => {
  type Row = { readonly time: number } & Record<string, unknown>
  class Series {
    readonly rows = new Map<number, Row>()
    last: number | undefined
    setData(rows: ReadonlyArray<Row>) {
      this.rows.clear()
      for (const row of rows) this.rows.set(row.time, row)
      this.last = rows.at(-1)?.time
    }
    update(row: Row, historical = false) {
      if (!historical && this.last !== undefined && row.time < this.last)
        throw new Error(
          `Cannot update oldest data, last time=${this.last}, new time=${row.time}`
        )
      if (historical && !this.rows.has(row.time))
        throw new Error(
          "Cannot update non-existing data point when historicalUpdate is true"
        )
      this.rows.set(row.time, row)
      if (!historical) this.last = row.time
    }
    priceScale() {
      return { applyOptions() {} }
    }
    attachPrimitive() {}
    createPriceLine() {
      return {}
    }
    removePriceLine() {}
  }
  const added: Array<Series> = []
  return { series: added, FakeSeries: Series }
})

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candlestick",
  HistogramSeries: "histogram",
  LineStyle: { Dashed: 2 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2 },
  createChart: () => ({
    addSeries: () => {
      const added = new FakeSeries()
      series.push(added)
      return added
    },
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }],
    subscribeClick() {},
    remove() {},
  }),
}))

const BBCA = StockCode.make("BBCA")
const minute = (wib: string) =>
  DateTime.makeUnsafe(`2026-11-09T${wib}:00+07:00`)
const seconds = (wib: string) => DateTime.toEpochMillis(minute(wib)) / 1000

const candle = (wib: string, close: number): Candle => ({
  code: BBCA,
  minute: minute(wib),
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  value: close * 100,
  frequency: 1,
})

const gap = (from: string, to: string): RelayGap => ({
  from: minute(from),
  to: minute(to),
})

// The animation frame the chart batches deltas into.
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

test("a candle backfilled into a relay gap after the last candle goes on the chart", async () => {
  const store = Effect.runSync(makeCandleStore(BBCA))
  store.apply({ _tag: "Delta", tape: [], candles: [candle("09:00", 100)] })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  await act(() =>
    root.render(<ChartCanvas store={store} gaps={[gap("09:01", "09:04")]} />)
  )
  const [candles, volume] = series
  // The gap's minutes are whitespace after the last candle.
  expect([...candles!.rows.keys()]).toEqual(
    ["09:00", "09:01", "09:02", "09:03"].map(seconds)
  )

  await act(() =>
    store.apply({ _tag: "Delta", tape: [], candles: [candle("09:02", 101)] })
  )
  await nextFrame()
  expect(candles!.rows.get(seconds("09:02"))).toMatchObject({ close: 101 })
  expect(volume!.rows.get(seconds("09:02"))).toMatchObject({ value: 1 })

  // A live candle after the gap still goes in as the newest bar.
  await act(() =>
    store.apply({ _tag: "Delta", tape: [], candles: [candle("09:05", 102)] })
  )
  await nextFrame()
  expect(candles!.rows.get(seconds("09:05"))).toMatchObject({ close: 102 })
  await act(() => root.unmount())
})
