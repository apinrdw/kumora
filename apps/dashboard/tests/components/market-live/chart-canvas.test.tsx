// @vitest-environment happy-dom
import {
  StockCode,
  TradeNumber,
  WibDate,
  marketPhases,
  type Candle,
  type RelayGap,
  type Sweep,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, test, vi } from "vitest"

import { makeCandleStore } from "@/components/market-live/candle-store"
import ChartCanvas from "@/components/market-live/chart-canvas"
import type { ChartPair } from "@/components/market-live/chart-pair"
import { makeReplayCursor } from "@/components/market-live/replay-cursor"
import { makeSweepStore } from "@/components/market-live/sweep-store"
import { replayDay } from "@/lib/replay"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Lightweight Charts draws on a canvas happy-dom lacks. This stands in with
// its data layer's two update rules (lightweight-charts 5.2.1,
// DataLayer.updateSeriesData): a bar older than the series' last bar,
// whitespace included, needs the historical flag, and the historical flag
// needs a bar at that time. Its chart keeps its click and double-click
// subscribers, and places every minute's centre at x 100 and every price at
// y 50, a minute 60 px wide. Each series knows the pane it was added to.
const { series, FakeSeries, mouse } = vi.hoisted(() => {
  type Row = { readonly time: number } & Record<string, unknown>
  type Listener = (parameter: unknown) => void
  const listeners = {
    clicks: new Set<Listener>(),
    dblClicks: new Set<Listener>(),
  }
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: 60 }),
      timeToCoordinate: () => 100,
    }),
    chartElement: () => document.body,
  }
  class Series {
    constructor(readonly pane: number) {}
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
    readonly options: Record<string, unknown> = {}
    priceScale() {
      return { applyOptions() {} }
    }
    applyOptions(options: Record<string, unknown>) {
      Object.assign(this.options, options)
    }
    attachPrimitive(primitive: {
      attached?: (parameter: Record<string, unknown>) => void
    }) {
      primitive.attached?.({ chart, series: this, requestUpdate() {} })
    }
    detachPrimitive() {}
    getPane() {
      return { paneIndex: () => this.pane }
    }
    priceToCoordinate() {
      return 50
    }
    createPriceLine() {
      return {}
    }
    removePriceLine() {}
  }
  const added: Array<Series> = []
  return { series: added, FakeSeries: Series, mouse: listeners }
})

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candlestick",
  HistogramSeries: "histogram",
  LineStyle: { Dashed: 2 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2 },
  createChart: () => ({
    addSeries: (_type: unknown, _options: unknown, paneIndex = 0) => {
      const added = new FakeSeries(paneIndex)
      series.push(added)
      return added
    },
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }],
    subscribeClick: (listener: (parameter: unknown) => void) =>
      mouse.clicks.add(listener),
    unsubscribeClick: (listener: (parameter: unknown) => void) =>
      mouse.clicks.delete(listener),
    subscribeDblClick: (listener: (parameter: unknown) => void) =>
      mouse.dblClicks.add(listener),
    unsubscribeDblClick: (listener: (parameter: unknown) => void) =>
      mouse.dblClicks.delete(listener),
    subscribeCrosshairMove() {},
    unsubscribeCrosshairMove() {},
    chartElement: () => document.body,
    remove() {},
  }),
}))

const BBCA = StockCode.make("BBCA")
const minute = (wib: string) =>
  DateTime.makeUnsafe(`2026-11-09T${wib}:00+07:00`)
const seconds = (wib: string) => DateTime.toEpochMillis(minute(wib)) / 1000

const candle = (wib: string, close: number, code = BBCA): Candle => ({
  code,
  minute: minute(wib),
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  value: close * 100,
  buyValue: 0,
  sellValue: 0,
  frequency: 1,
})

const gap = (from: string, to: string): RelayGap => ({
  from: minute(from),
  to: minute(to),
})

// The footprint chart isn't drawn here.
const alone: ChartPair = {
  attachCandles: () => () => {},
  attachFootprint: () => () => {},
  jumpTo: () => {},
  showUpTo: () => {},
  refit: () => {},
}

// The animation frame the chart batches deltas into.
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))

test("a candle backfilled into a relay gap after the last candle goes on the chart", async () => {
  const store = Effect.runSync(makeCandleStore(BBCA))
  store.apply({ _tag: "Delta", tape: [], candles: [candle("09:00", 100)] })
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  await act(() =>
    root.render(
      <ChartCanvas store={store} gaps={[gap("09:01", "09:04")]} pair={alone} />
    )
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

test("a minute its last regular-board trade left goes off the chart, its volume bar with it", async () => {
  series.length = 0
  const store = Effect.runSync(makeCandleStore(BBCA))
  const cells = [{ price: 100, sell: 0, buy: 1, none: 0 }]
  store.apply({
    _tag: "Delta",
    tape: [],
    candles: [candle("09:00", 100), candle("09:01", 101)],
    footprints: [
      { code: BBCA, minute: minute("09:00"), cells },
      { code: BBCA, minute: minute("09:01"), cells },
    ],
  })
  const root = createRoot(
    document.body.appendChild(document.createElement("div"))
  )
  await act(() =>
    root.render(<ChartCanvas store={store} gaps={[]} pair={alone} />)
  )
  const [candles, volume] = series
  expect([...candles!.rows.keys()]).toEqual(["09:00", "09:01"].map(seconds))

  await act(() =>
    store.apply({
      _tag: "Delta",
      tape: [],
      candles: [],
      footprints: [{ code: BBCA, minute: minute("09:01"), cells: [] }],
    })
  )
  await nextFrame()
  expect([...candles!.rows.keys()]).toEqual([seconds("09:00")])
  expect([...volume!.rows.keys()]).toEqual([seconds("09:00")])
  await act(() => root.unmount())
})

// The price a series' axis label and crosshair show for `value`: its custom
// formatter's, or Lightweight Charts' own at the format's precision.
const shownPrice = (
  shown: InstanceType<typeof FakeSeries>,
  value: number
): string => {
  const format = shown.options["priceFormat"] as
    | { type: string; precision?: number; formatter?: (n: number) => string }
    | undefined
  return format?.type === "custom" && format.formatter !== undefined
    ? format.formatter(value)
    : value.toFixed(format?.precision ?? 2)
}

test("an index's price axis keeps its decimals; a stock's snaps to its IDX tick", async () => {
  const shownOn = async (code: StockCode, close: number) => {
    series.length = 0
    const store = Effect.runSync(makeCandleStore(code))
    store.apply({
      _tag: "Delta",
      tape: [],
      candles: [candle("09:00", close, code)],
    })
    const root = createRoot(
      document.body.appendChild(document.createElement("div"))
    )
    await act(() =>
      root.render(<ChartCanvas store={store} gaps={[]} pair={alone} />)
    )
    const shown = shownPrice(series[0]!, close)
    await act(() => root.unmount())
    return shown
  }
  expect(await shownOn(StockCode.make("IHSG"), 4_971.287)).toMatch(
    /^4,?971\.29$/
  )
  expect(await shownOn(BBCA, 9_012)).toBe("9,000")
})

describe("a click on the candle chart of a recorded day", () => {
  const DAY = WibDate.make("2026-11-09")
  // A 30-lot buy sweep at 09:00:00 and a sell one at 09:00:30: their
  // bubbles sit at x 100 and x 130, y 50.
  const sweepAt = (
    firstTrade: string,
    time: string,
    side: Sweep["side"]
  ): Sweep => ({
    side,
    firstTrade: TradeNumber.make(firstTrade),
    time: DateTime.makeUnsafe(`2026-11-09T${time}+07:00`),
    first: 1_000,
    last: 1_000,
    lots: 30,
    value: 3_000_000,
    trades: 1,
  })
  const buy = sweepAt("1", "09:00:00", "buy")
  const sell = sweepAt("2", "09:00:30", "sell")
  // The click parameters Lightweight Charts hands its subscribers. A tap's
  // carries no hovered object: the library hit-tests where the crosshair
  // was, and a tap moved none there.
  const at = (x: number, paneIndex: number) => ({
    time: seconds("09:00"),
    point: { x, y: 50 },
    paneIndex,
    hoveredObjectId: undefined,
  })
  const fire = (
    listeners: Set<(parameter: unknown) => void>,
    x: number,
    paneIndex = 0
  ) =>
    act(() => {
      for (const listener of listeners) listener(at(x, paneIndex))
    })

  const shown = async () => {
    series.length = 0
    mouse.clicks.clear()
    mouse.dblClicks.clear()
    const store = Effect.runSync(makeCandleStore(BBCA))
    store.apply({ _tag: "Delta", tape: [], candles: [candle("09:00", 1_000)] })
    const sweeps = Effect.runSync(makeSweepStore(BBCA))
    sweeps.answer(0, { code: BBCA, sweeps: [buy, sell] })
    const cursor = Effect.runSync(
      marketPhases(DAY).pipe(
        Effect.flatMap((phases) => replayDay(DAY, phases)),
        Effect.flatMap(makeReplayCursor)
      )
    )
    const root = createRoot(
      document.body.appendChild(document.createElement("div"))
    )
    await act(() =>
      root.render(
        <ChartCanvas
          store={store}
          sweeps={sweeps}
          cursor={cursor}
          gaps={[]}
          pair={alone}
        />
      )
    )
    return { sweeps, cursor, root }
  }

  test("a tap on a bubble selects its sweep and leaves the cursor where it was", async () => {
    const { sweeps, cursor, root } = await shown()
    const before = cursor.state().at
    await fire(mouse.clicks, 130)
    expect(sweeps.selected()).toBe(sell.firstTrade)
    expect(cursor.state().at).toBe(before)
    // Off every bubble, a click still moves the cursor to its minute.
    await fire(mouse.clicks, 300)
    expect(cursor.state().at).not.toBe(before)
    await act(() => root.unmount())
  })

  test("a click in the volume pane, below a bubble, moves the cursor and selects no sweep", async () => {
    const { sweeps, cursor, root } = await shown()
    const before = cursor.state().at
    await fire(mouse.clicks, 130, 1)
    expect(sweeps.selected()).toBeUndefined()
    expect(cursor.state().at).not.toBe(before)
    await act(() => root.unmount())
  })

  test("a quick second click on a bubble, reported as a double click, selects its sweep", async () => {
    const { sweeps, root } = await shown()
    await fire(mouse.clicks, 130)
    await fire(mouse.dblClicks, 100)
    expect(sweeps.selected()).toBe(buy.firstTrade)
    await act(() => root.unmount())
  })
})
