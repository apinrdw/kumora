// @vitest-environment happy-dom
import { StockCode, type BookReadings, type ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { makeBookReadingsStore } from "@/components/market-live/book-readings-store"
import { makeFiguresStore } from "@/components/order-book-radar/figures-store"
import { makeRadarEventsStore } from "@/components/order-book-radar/radar-events-store"
import { useRanking } from "@/components/order-book-radar/use-ranking"
import { DEFAULT_SETTINGS } from "@/lib/order-book-radar"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const T0 = Date.parse("2026-11-18T02:30:00.000Z")
const FIRST = StockCode.make("RHAA")
const SECOND = StockCode.make("RHBB")

const side = (lots: number): BookReadings["bid"] => ({
  lots,
  lotsPerOrder: lots / 2,
})

// A code's readings, `bid` lots against 100.
const readings = (code: StockCode, bid: number): BookReadings => ({
  code,
  at: DateTime.makeUnsafe(Date.now()),
  imbalance: (bid - 100) / (bid + 100),
  bid: side(bid),
  offer: side(100),
})

const delta = (each: ReadonlyArray<BookReadings>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(Date.now()),
  tape: [],
  candles: [],
  bookReadings: each,
})

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.useRealTimers()
})

test("the order shown before the first second's tick holds while the pointer is on it", () => {
  vi.useFakeTimers({ now: T0 })
  const stores = {
    readings: Effect.runSync(makeBookReadingsStore),
    figures: Effect.runSync(makeFiguresStore),
    events: Effect.runSync(makeRadarEventsStore),
  }
  stores.readings.apply(delta([readings(FIRST, 900), readings(SECOND, 300)]))
  // Both worth Rp2 B today.
  stores.figures.apply({
    ...delta([]),
    scannerFigures: [FIRST, SECOND].map((code) => ({
      code,
      last: 1_000,
      previousClose: 1_000,
      previousValue: undefined,
      value: 2e9,
    })),
  })
  const board = new Set<StockCode>()
  const watchlist = new Set<StockCode>()
  const clockOffset = { current: 0 }
  let order: ReadonlyArray<StockCode> = []
  function Scanner({ hovering }: { hovering: boolean }) {
    order = useRanking({
      ...stores,
      settings: DEFAULT_SETTINGS,
      board,
      watchlist,
      clockOffset,
      hovering,
    }).scan.bid
    return null
  }
  const host = document.createElement("div")
  root = createRoot(host)
  act(() => root!.render(<Scanner hovering={false} />))
  expect(order).toEqual([FIRST, SECOND])
  // The pointer lands on the list, then the second turns more lopsided.
  act(() => root!.render(<Scanner hovering />))
  stores.readings.apply(delta([readings(SECOND, 1_900)]))
  act(() => {
    vi.advanceTimersByTime(7_000)
  })
  expect(order).toEqual([FIRST, SECOND])
  // Off the list, the next re-sort takes the new readings.
  act(() => root!.render(<Scanner hovering={false} />))
  act(() => {
    vi.advanceTimersByTime(6_000)
  })
  expect(order).toEqual([SECOND, FIRST])
})
