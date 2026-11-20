// @vitest-environment happy-dom
// The scanner's rows as a live table (CODING_STANDARDS.md, "Live tables use
// the keyed-store pattern with React.memo rows"): a code's new readings
// re-render its row alone, and the page re-rendering with the same view
// re-renders none.
import {
  StockCode,
  type BookReadings,
  type StockCode as Code,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { makeBookReadingsStore } from "@/components/market-live/book-readings-store"
import { Halves, type RowView } from "@/components/order-book-radar/scanner"
import { rankedFigure, type Scan } from "@/lib/order-book-radar"

// Each row draws its Ranked by figure once a render.
vi.mock("@/lib/order-book-radar", { spy: true })
const renders = () => {
  const counted: Record<string, number> = {}
  for (const [readings] of vi.mocked(rankedFigure).mock.calls)
    counted[readings.code] = (counted[readings.code] ?? 0) + 1
  return counted
}

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const NOW = Date.parse("2026-11-18T02:30:00.000Z")
const FIRST = StockCode.make("RHAA")
const SECOND = StockCode.make("RHBB")

const side = (lots: number): BookReadings["bid"] => ({
  lots,
  lotsPerOrder: lots / 2,
})

const readings = (code: Code, bid: number): BookReadings => ({
  code,
  at: DateTime.makeUnsafe(NOW),
  imbalance: (bid - 100) / (bid + 100),
  bid: side(bid),
  offer: side(100),
})

const delta = (each: ReadonlyArray<BookReadings>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(NOW),
  tape: [],
  candles: [],
  bookReadings: each,
})

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.clearAllMocks()
})

test("a code's new readings re-render its row alone, and the same view none", () => {
  const store = Effect.runSync(makeBookReadingsStore)
  store.apply(delta([readings(FIRST, 300), readings(SECOND, 300)]))
  const watchlist = new Set<Code>()
  const events = new Map()
  const onUnfold = () => undefined
  const onOpen = () => undefined
  const view = (): RowView => ({
    readings: store,
    rankBy: "imbalance",
    marketNow: NOW,
    watchlist,
    events,
    unfolded: undefined,
    onUnfold,
    book: undefined,
    onOpen,
  })
  const scan: Scan = {
    bid: [FIRST, SECOND],
    offer: [],
    limits: [],
    above: 2,
    board: 0,
    cheap: 0,
  }
  const host = document.createElement("div")
  root = createRoot(host)
  act(() =>
    root!.render(<Halves scan={scan} view={view()} onHover={() => {}} />)
  )
  const imbalanceOf = (code: Code) =>
    host.querySelector(`[data-code="${code}"] [aria-label="Imbalance"]`)
      ?.textContent
  expect(imbalanceOf(FIRST)).toBe("+50%")
  vi.mocked(rankedFigure).mockClear()

  act(() => store.apply(delta([readings(FIRST, 900)])))
  expect(
    imbalanceOf(FIRST),
    "the delta's imbalance shows in its row at once"
  ).toBe("+80%")
  expect(renders(), "only the changed code's row re-rendered").toEqual({
    [FIRST]: 1,
  })

  vi.mocked(rankedFigure).mockClear()
  act(() =>
    root!.render(<Halves scan={scan} view={view()} onHover={() => {}} />)
  )
  expect(
    renders(),
    "a page re-render with the same view re-renders no row"
  ).toEqual({})
})

test("a row's last-event chip shows an order flow event's mark and its minute", () => {
  const store = Effect.runSync(makeBookReadingsStore)
  store.apply(delta([readings(FIRST, 300)]))
  const events = new Map([
    [
      FIRST,
      {
        last: {
          kind: "exhaustion" as const,
          code: FIRST,
          at: DateTime.makeUnsafe(NOW - 60_000),
          side: "sell" as const,
          price: 500,
          lots: 900,
          peakLots: 2400,
          ticks: 1,
          widestTicks: 5,
        },
        inFiveMinutes: 1,
      },
    ],
  ])
  const host = document.createElement("div")
  root = createRoot(host)
  act(() =>
    root!.render(
      <Halves
        scan={{
          bid: [FIRST],
          offer: [],
          limits: [],
          above: 1,
          board: 0,
          cheap: 0,
        }}
        view={{
          readings: store,
          rankBy: "imbalance",
          marketNow: NOW,
          watchlist: new Set(),
          events,
          unfolded: undefined,
          onUnfold: () => undefined,
          book: undefined,
          onOpen: () => undefined,
        }}
        onHover={() => {}}
      />
    )
  )
  const chip = host.querySelector(
    `[data-code="${FIRST}"] [aria-label="Last event"]`
  )
  expect(chip?.textContent).toBe("▼E09:29")
  expect(chip?.querySelector("abbr")?.getAttribute("title")).toBe(
    "Selling exhaustion at the day's low: sell-aggressor lots 2,400 → 900 a minute · range 5 → 1 ticks"
  )
})

test("a lopsided row shows its heavy side's chip after the imbalance", () => {
  const store = Effect.runSync(makeBookReadingsStore)
  const SMALL = StockCode.make("RHCC")
  const UNTAGGED = StockCode.make("RHDD")
  store.apply(
    delta([
      // 150 lots per order against 50: big orders.
      readings(FIRST, 300),
      // 300 lots on 100 orders against 100 on 10: small orders.
      {
        ...readings(SMALL, 300),
        bid: { lots: 300, lotsPerOrder: 3 },
        offer: { lots: 100, lotsPerOrder: 10 },
      },
      // Under 50% lopsided.
      readings(UNTAGGED, 120),
    ])
  )
  const view: RowView = {
    readings: store,
    rankBy: "imbalance",
    marketNow: NOW,
    watchlist: new Set(),
    events: new Map(),
    unfolded: undefined,
    onUnfold: () => undefined,
    book: undefined,
    onOpen: () => undefined,
  }
  const scan: Scan = {
    bid: [FIRST, SMALL, UNTAGGED],
    offer: [],
    limits: [],
    above: 3,
    board: 0,
    cheap: 0,
  }
  const host = document.createElement("div")
  root = createRoot(host)
  act(() => root!.render(<Halves scan={scan} view={view} onHover={() => {}} />))
  const chipOf = (code: Code) =>
    host.querySelector(`[data-code="${code}"] [aria-label="Heavy side"]`)
  expect(chipOf(FIRST)?.textContent).toBe("big orders")
  expect(chipOf(FIRST)?.className).toContain("text-warning")
  expect(chipOf(SMALL)?.textContent).toBe("small orders")
  expect(chipOf(SMALL)?.className).toContain("text-muted-foreground")
  expect(chipOf(UNTAGGED)).toBeNull()
})
