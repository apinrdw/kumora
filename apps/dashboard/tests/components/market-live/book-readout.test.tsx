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
  nearDepth: lots * 100 * 1_000,
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
  bookReadings: ReadonlyArray<BookReadings>,
  at = 0
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(at),
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

// The Special Monitoring Board list the readout reads: the Worker's answer
// stands in for the hook's fetch.
const board = vi.hoisted(() => ({ codes: new Set<string>() }))
vi.mock("@/components/market-live/use-special-board", () => ({
  useSpecialBoard: () => board.codes,
}))

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
  board.codes = new Set()
  Effect.runSync(resetConditions)
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.localStorage.clear()
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

test("in the break the readings grey out, naming the phase and when they paused on the object's clock", () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  // This browser's clock runs 20 minutes slow: 11:50, before the break.
  vi.setSystemTime(new Date("2026-11-18T11:50:00+07:00"))
  const { container } = render(
    "ERAA",
    snapshot(
      "break",
      [readingsOf("ERAA")],
      Date.parse("2026-11-18T12:10:00+07:00")
    )
  )
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

test("a Special Monitoring Board code says why it has no readings, at any price", () => {
  board.codes = new Set(["WSBP"])
  const { container, book } = render("WSBP", snapshot("session-1", []))
  const reason =
    "Special Monitoring Board: this code trades in a call auction all day, and no order book arrives for it."
  expect(container.textContent).toContain(reason)
  act(() =>
    book.replace({
      _tag: "OrderBook",
      code: StockCode.make("WSBP"),
      bids: [{ price: 7, lots: 100, orders: 3 }],
      offers: [{ price: 8, lots: 100, orders: 3 }],
      bidLots: 100,
      offerLots: 100,
      at: DateTime.makeUnsafe("2026-11-18T03:00:00Z"),
      provenance: "Stockbit",
      previousClose: 7,
    })
  )
  expect(container.textContent).toContain(reason)
  expect(container.textContent).not.toContain("One tick here")
})

const ERAA_BOOK = {
  _tag: "OrderBook",
  code: StockCode.make("ERAA"),
  bids: [
    { price: 1000, lots: 50, orders: 5 },
    { price: 990, lots: 30, orders: 3 },
  ],
  offers: [
    { price: 1010, lots: 25, orders: 5 },
    { price: 1015, lots: 25, orders: 1 },
    { price: 1040, lots: 50, orders: 10 },
  ],
  bidLots: 80,
  offerLots: 100,
  at: DateTime.makeUnsafe("2026-11-18T03:00:00Z"),
  provenance: "Stockbit",
} as const

// The readout of ERAA live in Session 1, holding ERAA_BOOK.
const renderFill = () => {
  const shown = render("ERAA", snapshot("session-1", [readingsOf("ERAA")]))
  act(() => shown.book.replace(ERAA_BOOK))
  return shown.container
}

const fillTable = (container: HTMLElement) =>
  container.querySelector('[aria-label="Fill estimate"]')?.textContent ?? ""

const typeSize = (container: HTMLElement, text: string) => {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Order size"]'
  )
  if (input === null) throw new Error("no order size field")
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const pick = (container: HTMLElement, unit: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === unit
  )
  act(() => button?.click())
}

test("the fill estimate walks the offers to buy and the bids to sell", () => {
  const container = renderFill()
  pick(container, "Lots")
  typeSize(container, "60")
  const text = fillTable(container)
  // 25 at 1,010, 25 at 1,015 and 10 at 1,040: three levels, 6 ticks.
  expect(text).toContain("1,040")
  expect(text).toContain("1,017")
  expect(text).toContain("6 ticks · 0.70%")
  // 50 at 1,000 and 10 at 990.
  expect(text).toContain("2 ticks · 0.17%")
})

test("a size past the book's levels says what they cover", () => {
  const container = renderFill()
  pick(container, "Lots")
  typeSize(container, "500")
  expect(container.textContent).toContain(
    "More than the 3 levels shown: the offers cover 100 lots (Rp10.26 M)"
  )
  expect(container.textContent).toContain(
    "More than the 2 levels shown: the bids cover 80 lots (Rp7.97 M)"
  )
})

test("the order size and its unit stay in this browser", () => {
  const first = renderFill()
  expect(first.querySelector('[aria-pressed="true"]')?.textContent).toBe(
    "Rupiah"
  )
  pick(first, "Lots")
  typeSize(first, "60")
  document.body.innerHTML = ""
  const again = renderFill()
  expect(again.querySelector('[aria-pressed="true"]')?.textContent).toBe("Lots")
  expect(
    again.querySelector<HTMLInputElement>('input[aria-label="Order size"]')
      ?.value
  ).toBe("60")
})

test("blocked storage falls back to the default size and still estimates", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked")
  })
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked")
  })
  const container = renderFill()
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe(
    "Rupiah"
  )
  pick(container, "Lots")
  typeSize(container, "10")
  expect(fillTable(container)).toContain("1,010")
})
