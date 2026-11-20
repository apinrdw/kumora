// @vitest-environment happy-dom
import {
  StockCode,
  type BookEvent,
  type MarketPhase,
  type OrderBook,
  type OrderFlowEvent,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { makeBookEventStore } from "@/components/market-live/book-event-store"
import { BookEventList } from "@/components/market-live/book-events"
import { OrderBookPanel } from "@/components/market-live/order-book-panel"
import {
  applyConditions,
  resetConditions,
} from "@/components/market-live/market-conditions"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"
import type { ReplayCursor } from "@/components/market-live/replay-cursor"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const FOLK = StockCode.make("FOLK")
// 09:17:00 WIB.
const T0 = Date.parse("2026-11-17T02:17:00Z")

const appeared = (seconds: number, price: number): BookEvent => ({
  kind: "appeared",
  code: FOLK,
  at: DateTime.makeUnsafe(T0 + seconds * 1000),
  side: "bid",
  price,
  lots: 50_000,
  orders: 1,
  ticks: 6,
})
const pulled: BookEvent = {
  kind: "pulled",
  code: FOLK,
  at: DateTime.makeUnsafe(T0 + 75_000),
  side: "bid",
  price: 100,
  lots: 50_000,
  orders: 1,
  ticks: 6,
  approached: false,
}
const EVENTS = [appeared(34, 100), appeared(44, 99), pulled]

// A recorded day's cursor held at `at`.
const cursorAt = (at: number): ReplayCursor => ({
  day: { date: "2026-11-17" } as ReplayCursor["day"],
  state: () => ({ at, playing: false, speed: 1 }),
  subscribe: () => () => {},
  toggle: () => {},
  pause: () => {},
  seek: () => {},
  setSpeed: () => {},
  pickMinute: () => {},
  dispose: () => {},
})

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ""
  vi.useRealTimers()
})

const render = (node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

const rows = (host: HTMLElement) =>
  [...host.querySelectorAll("li button")].map((row) => ({
    text: row.textContent,
    dimmed: row.className.includes("opacity-30"),
    picked: row.getAttribute("aria-pressed") === "true",
  }))

test("a recorded day lists the code's events newest first, dimmed past the cursor", () => {
  const store = Effect.runSync(makeBookEventStore(FOLK))
  store.load({ code: FOLK, recorded: true, events: EVENTS })
  const host = render(
    <BookEventList store={store} cursor={cursorAt(T0 + 50_000)} />
  )
  expect(rows(host)).toEqual([
    {
      text: "09:18:15Pulled50 K lots at 100 · 1 order · 6 ticks",
      dimmed: true,
      picked: false,
    },
    {
      text: "09:17:44Wall appeared50 K lots at 99 · 1 order · 6 ticks away",
      dimmed: false,
      picked: false,
    },
    {
      text: "09:17:34Wall appeared50 K lots at 100 · 1 order · 6 ticks away",
      dimmed: false,
      picked: false,
    },
  ])
  act(() => (host.querySelectorAll("li button")[1] as HTMLElement).click())
  expect(rows(host).map((row) => row.picked)).toEqual([false, true, false])
  expect(store.picked()).toBe(`FOLK|appeared|bid|99|${T0 + 44_000}`)
})

test("a link lands on its event again after Back from another code", () => {
  const key = `FOLK|appeared|bid|99|${T0 + 44_000}`
  const loaded = (code: StockCode, events: ReadonlyArray<BookEvent>) => {
    const store = Effect.runSync(makeBookEventStore(code))
    store.load({ code, recorded: true, events })
    return store
  }
  const first = loaded(FOLK, EVENTS)
  const host = render(
    <BookEventList store={first} cursor={undefined} landOn={key} />
  )
  expect(first.picked()).toBe(key)
  // Another code picked, then Back: a fresh store for the event's code.
  const other = StockCode.make("BBCA")
  act(() =>
    root!.render(<BookEventList store={loaded(other, [])} cursor={undefined} />)
  )
  const back = loaded(FOLK, EVENTS)
  act(() =>
    root!.render(<BookEventList store={back} cursor={undefined} landOn={key} />)
  )
  expect(back.picked(), "Back picks the event again").toBe(key)
  expect(rows(host).map((row) => row.picked)).toEqual([false, true, false])
})

test("a day recorded before book events says so", () => {
  const store = Effect.runSync(makeBookEventStore(FOLK))
  store.load({ code: FOLK, recorded: false, events: [] })
  const host = render(<BookEventList store={store} cursor={cursorAt(T0)} />)
  expect(host.textContent).toContain("Book events not recorded before")
})

const QUIET =
  "Too quiet to read: fewer than 2 book updates a side in the last 30 s."

// A store that heard the object's snapshot of FOLK at T0 in `phase`, with
// one frame a side, and nothing since for `after` ms.
const heard = (
  after: number,
  phase: MarketPhase,
  events: ReadonlyArray<BookEvent> = []
) => {
  vi.useFakeTimers({ now: T0 })
  const message: ViewerDown = {
    _tag: "Snapshot",
    at: DateTime.makeUnsafe(T0),
    selected: FOLK,
    tape: [],
    candles: [],
    footprints: [],
    conditions: {
      phase,
      relayOnline: true,
      feeds: { Stockbit: "live", Ajaib: "live" },
      gaps: [],
    },
    selectedBookEvents: events,
    orderBook: {
      _tag: "OrderBook",
      code: FOLK,
      bids: [],
      offers: [],
      bidLots: 0,
      offerLots: 0,
      at: DateTime.makeUnsafe(T0),
      provenance: "Stockbit",
    },
  }
  const store = Effect.runSync(makeBookEventStore(FOLK))
  store.apply(message)
  Effect.runSync(Effect.andThen(resetConditions, applyConditions(message)))
  vi.setSystemTime(T0 + after)
  return store
}

test("live, a code without 2 book updates a side in 30 s is too quiet to read", () => {
  const host = render(
    <BookEventList store={heard(40_000, "session-1")} cursor={undefined} />
  )
  expect(host.textContent).toContain(QUIET)
})

test("too quiet shows only in a session, with no events listed", () => {
  // The lunch break: the strip says readings are paused.
  const paused = render(
    <BookEventList store={heard(40_000, "break")} cursor={undefined} />
  )
  expect(paused.textContent).not.toContain(QUIET)
  act(() => root?.unmount())
  // Earlier events stand on their own.
  const listed = render(
    <BookEventList
      store={heard(40_000, "session-1", EVENTS)}
      cursor={undefined}
    />
  )
  expect(listed.textContent).not.toContain(QUIET)
  expect(listed.querySelectorAll("li")).toHaveLength(3)
})

test("a code just picked is not called too quiet", () => {
  const host = render(
    <BookEventList store={heard(1_000, "session-1")} cursor={undefined} />
  )
  expect(host.textContent).not.toContain(QUIET)
  expect(host.textContent).toContain("No book events yet today.")
})

test("the ladder marks a level's events of the last 2 minutes under a legend", () => {
  const book: OrderBook = {
    _tag: "OrderBook",
    code: FOLK,
    bids: [
      { price: 101, lots: 10, orders: 1 },
      { price: 100, lots: 50_000, orders: 1 },
    ],
    offers: [{ price: 102, lots: 10, orders: 1 }],
    bidLots: 50_010,
    offerLots: 10,
    at: DateTime.makeUnsafe(T0),
    provenance: "Stockbit",
  }
  const store = Effect.runSync(makeOrderBookStore(FOLK))
  store.replace(book)
  const host = render(
    <OrderBookPanel store={store} marks={[appeared(34, 100)]} />
  )
  const marks = [...host.querySelectorAll("abbr")]
  expect(marks.map((mark) => [mark.textContent, mark.title])).toEqual([
    ["W+", "Wall appeared: 50 K lots at 100 · 1 order · 6 ticks away"],
  ])
  expect(marks[0]!.closest("tr")?.textContent).toContain("100")
  expect(host.textContent).toContain("Marks on a level: AB absorbed")
})

const exhaustion = (seconds: number): OrderFlowEvent => ({
  kind: "exhaustion",
  code: FOLK,
  at: DateTime.makeUnsafe(T0 + seconds * 1000),
  side: "sell",
  price: 98,
  lots: 900,
  peakLots: 24_000,
  ticks: 1,
  widestTicks: 4,
})

test("live, the code's order flow events list among its book events and a link lands on one", () => {
  vi.useFakeTimers({ now: T0 + 120_000 })
  const store = Effect.runSync(makeBookEventStore(FOLK))
  const snapshot: ViewerDown = {
    _tag: "Snapshot",
    at: DateTime.makeUnsafe(T0 + 100_000),
    selected: FOLK,
    tape: [],
    candles: [],
    footprints: [],
    conditions: {
      phase: "session-1",
      relayOnline: true,
      feeds: { Stockbit: "live", Ajaib: "live" },
      gaps: [],
    },
    selectedBookEvents: [appeared(34, 100)],
    selectedOrderFlowEvents: [exhaustion(0)],
  }
  store.apply(snapshot)
  store.apply({
    _tag: "Delta",
    at: DateTime.makeUnsafe(T0 + 120_000),
    tape: [],
    candles: [],
    orderFlowEvents: [
      exhaustion(60),
      { ...exhaustion(60), code: StockCode.make("BBCA") },
    ],
  })
  const key = `FOLK|exhaustion|sell|98|${T0}`
  const host = render(
    <BookEventList store={store} cursor={undefined} landOn={key} />
  )
  expect(rows(host)).toEqual([
    {
      text: "09:18:00▼ESelling exhaustion at the day's lowsell-aggressor lots 24,000 → 900 a minute · range 4 → 1 ticks",
      dimmed: false,
      picked: false,
    },
    {
      text: "09:17:34Wall appeared50 K lots at 100 · 1 order · 6 ticks away",
      dimmed: false,
      picked: false,
    },
    {
      text: "09:17:00▼ESelling exhaustion at the day's lowsell-aggressor lots 24,000 → 900 a minute · range 4 → 1 ticks",
      dimmed: false,
      picked: true,
    },
  ])
})
