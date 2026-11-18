// @vitest-environment happy-dom
import { StockCode, type BookEvent, type OrderBook } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"

import { makeBookEventStore } from "@/components/market-live/book-event-store"
import {
  BookEventList,
  usePickedEvent,
} from "@/components/market-live/book-events"
import { OrderBookPanel } from "@/components/market-live/order-book-panel"
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

test("a day recorded before book events says so", () => {
  const store = Effect.runSync(makeBookEventStore(FOLK))
  store.load({ code: FOLK, recorded: false, events: [] })
  const host = render(<BookEventList store={store} cursor={cursorAt(T0)} />)
  expect(host.textContent).toContain("Book events not recorded before")
})

test("live, a code without 2 book updates a side in 30 s is too quiet to read", () => {
  vi.useFakeTimers({ now: T0 + 1_000 })
  const store = Effect.runSync(makeBookEventStore(FOLK))
  const host = render(<BookEventList store={store} cursor={undefined} />)
  expect(host.textContent).toContain(
    "Too quiet to read: fewer than 2 book updates a side in the last 30 s."
  )
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

test("an alert's event picks and scrolls to its row once its events arrive", () => {
  vi.useFakeTimers({ now: T0 + 80_000 })
  const scrolled = vi.fn<() => void>()
  Element.prototype.scrollIntoView = scrolled
  const store = Effect.runSync(makeBookEventStore(FOLK))
  const key = `FOLK|appeared|bid|99|${T0 + 44_000}`
  function Opened() {
    usePickedEvent(store, key)
    return <BookEventList store={store} cursor={undefined} />
  }
  const host = render(<Opened />)
  expect(store.picked()).toBeUndefined()
  act(() => store.load({ code: FOLK, recorded: true, events: EVENTS }))
  expect(rows(host).map((row) => row.picked)).toEqual([false, true, false])
  expect(scrolled).toHaveBeenCalledOnce()
  // Unpicked by hand, it stays unpicked.
  act(() => (host.querySelectorAll("li button")[1] as HTMLElement).click())
  act(() => store.load({ code: FOLK, recorded: true, events: EVENTS }))
  expect(store.picked()).toBeUndefined()
})
