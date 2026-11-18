// @vitest-environment happy-dom
import { clientRuntime } from "@workspace/client"
import {
  StockCode,
  WibDate,
  type BookReadings,
  type MarketPhase,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { makeBookReadingsStore } from "@/components/market-live/book-readings-store"
import { BookReadout } from "@/components/market-live/book-readout"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import {
  applyConditions,
  resetConditions,
} from "@/components/market-live/market-conditions"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const TODAY = WibDate.make("2026-11-18")

const side = (lots: number) => ({
  depth: lots * 100 * 1_000,
  lots,
  emptyTicks: 3,
  widestGap: 2,
  lotsPerOrder: 12,
})

const readingsOf = (
  code: string,
  extra: Partial<BookReadings> = {}
): BookReadings => ({
  code: StockCode.make(code),
  at: DateTime.makeUnsafe("2026-11-18T03:00:00Z"),
  value: 1e9,
  imbalance: 0.25,
  spread: { ticks: 2, percent: 0.4 },
  limit: undefined,
  bid: side(1_000),
  offer: side(600),
  ...extra,
})

const snapshot = (
  phase: MarketPhase,
  bookReadings: ReadonlyArray<BookReadings>
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(0),
  selected: StockCode.make("ERAA"),
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase,
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
  bookReadings,
})

// The readout of `code` live, after the socket's snapshot.
const render = (code: string, message: ViewerDown) => {
  const readings = Effect.runSync(makeBookReadingsStore)
  const book = Effect.runSync(makeOrderBookStore(StockCode.make(code)))
  const dayStates = clientRuntime.runSync(makeDayStateStore())
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  act(() => {
    Effect.runSync(applyConditions(message))
    readings.apply(message)
    root.render(
      <BookReadout
        code={StockCode.make(code)}
        today={TODAY}
        readings={readings}
        book={book}
        dayStates={dayStates}
        cursor={undefined}
        gaps={[]}
      />
    )
  })
  return { container, book }
}

afterEach(() => {
  Effect.runSync(resetConditions)
  vi.useRealTimers()
  document.body.innerHTML = ""
})

test("live readings show imbalance, the bid/offer grid, the spread and the disclaimer", () => {
  const { container } = render(
    "ERAA",
    snapshot("session-1", [readingsOf("ERAA")])
  )
  const text = container.textContent ?? ""
  expect(text).toContain("+25%")
  expect(text).toContain("3 (widest 2)")
  expect(text).toContain("2 ticks · 0.40%")
  expect(text).toContain("aren't advice to buy or sell")
  expect(container.querySelector("[data-paused]")).toBeNull()
})

test("a code at its limit shows the limit pill and no imbalance", () => {
  const { container } = render(
    "ERAA",
    snapshot("session-2", [readingsOf("ERAA", { limit: "upper" })])
  )
  const text = container.textContent ?? ""
  expect(text).toContain("At upper limit")
  expect(
    container.querySelector('[aria-label="Imbalance value"]')?.textContent
  ).toBe("—")
})

test("in the break the readings grey out, naming the phase and when they paused", () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-18T12:10:00+07:00"))
  const { container } = render("ERAA", snapshot("break", [readingsOf("ERAA")]))
  expect(container.querySelector("[data-paused]")?.textContent).toContain(
    "Break · readings paused at 12:00:00"
  )
})

test("an index and a code priced Rp1–10 say why they have no readings", () => {
  const index = render("IHSG", snapshot("session-1", []))
  expect(index.container.textContent).toContain("Indices have no order book.")
  const cheap = render("LAPD", snapshot("session-1", []))
  act(() =>
    cheap.book.replace({
      _tag: "OrderBook",
      code: StockCode.make("LAPD"),
      bids: [{ price: 7, lots: 100, orders: 3 }],
      offers: [{ price: 8, lots: 100, orders: 3 }],
      bidLots: 100,
      offerLots: 100,
      at: DateTime.makeUnsafe("2026-11-18T03:00:00Z"),
      provenance: "Stockbit",
      previousClose: 7,
    })
  )
  expect(cheap.container.textContent).toContain(
    "One tick here moves the price 10–100%"
  )
})
