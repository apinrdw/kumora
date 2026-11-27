// @vitest-environment happy-dom
import type * as Client from "@workspace/client"
import { clientRuntime } from "@workspace/client"
import {
  StockCode,
  WibDate,
  type BookChunk,
  type OrderBook,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, test, vi } from "vitest"

import { makeCandleStore } from "@/components/market-live/candle-store"
import { makeDayStateStore } from "@/components/market-live/day-state-store"
import { makeOrderBookStore } from "@/components/market-live/order-book-store"
import { useRecordedDay } from "@/components/market-live/recorded-day"
import { makeReplayCursor } from "@/components/market-live/replay-cursor"
import { replayDay } from "@/lib/replay"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  bookChunk:
    vi.fn<
      (minute: DateTime.Utc) => Effect.Effect<Option.Option<BookChunk>, unknown>
    >(),
}))

// The recorded day's GETs, answered here: nothing but the book chunks.
vi.mock("@workspace/client", async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  fetchRecordedGaps: () => Effect.succeed([]),
  fetchRecordedCandles: () => Effect.succeed(Option.none()),
  fetchRecordedBookChunk: (
    _day: WibDate,
    _code: StockCode,
    minute: DateTime.Utc
  ) => mocks.bookChunk(minute),
}))

const BBCA = StockCode.make("BBCA")
const DAY = WibDate.make("2026-11-09")

const bookOf = (minute: number): OrderBook => ({
  _tag: "OrderBook",
  code: BBCA,
  bids: [{ price: 9_000, lots: 1, orders: 1 }],
  offers: [],
  bidLots: 1,
  offerLots: 0,
  at: DateTime.makeUnsafe(minute),
  provenance: "Stockbit",
})

// A minute's chunk: its book at its start, and no delta.
const chunkOf = (minute: number): BookChunk => ({
  code: BBCA,
  minute: DateTime.makeUnsafe(minute),
  start: bookOf(minute),
  deltas: [],
})

// The hook over `cursor`, filling `book`; returns the unmount.
const mount = async (
  cursor: Effect.Success<ReturnType<typeof makeReplayCursor>>,
  book: Effect.Success<ReturnType<typeof makeOrderBookStore>>
) => {
  const candles = Effect.runSync(makeCandleStore(BBCA))
  const dayStates = clientRuntime.runSync(makeDayStateStore())
  function Harness() {
    useRecordedDay({
      day: DAY,
      cursor,
      selected: BBCA,
      watchlist: [],
      candles,
      book,
      dayStates,
    })
    return null
  }
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  await act<void>(() => root.render(<Harness />))
  return () => act(() => root.unmount())
}

test("a book chunk whose load failed is asked for again when the cursor visits its minute again", async () => {
  const cursor = Effect.runSync(
    Effect.flatMap(replayDay(DAY, []), makeReplayCursor)
  )
  const closeMinute = Math.floor(cursor.state().at / MINUTE_MS) * MINUTE_MS
  // The close minute's chunk: the relay's first answer fails, the next is the
  // chunk; any other minute has no book.
  let closeAsked = 0
  mocks.bookChunk.mockImplementation((minute) => {
    if (DateTime.toEpochMillis(minute) !== closeMinute)
      return Effect.succeed(Option.none())
    closeAsked += 1
    return closeAsked === 1
      ? Effect.fail("recorded day not served")
      : Effect.succeed(Option.some(chunkOf(closeMinute)))
  })
  const book = Effect.runSync(makeOrderBookStore(BBCA))
  const unmount = await mount(cursor, book)
  await vi.waitFor(() => expect(closeAsked).toBe(1))
  expect(book.book()).toBeUndefined()

  // Away to the minute before, then back.
  act(() => cursor.seek(closeMinute - MINUTE_MS))
  act(() => cursor.seek(closeMinute))
  await vi.waitFor(() => expect(book.book()?._tag).toBe("OrderBook"))
  expect(closeAsked).toBe(2)
  unmount()
})

test("the cursor on a minute whose chunk hasn't answered shows no book, the last minute's included after its load failed", async () => {
  const cursor = Effect.runSync(
    Effect.flatMap(replayDay(DAY, []), makeReplayCursor)
  )
  const closeMinute = Math.floor(cursor.state().at / MINUTE_MS) * MINUTE_MS
  const earlier = closeMinute - MINUTE_MS
  // The close minute's chunk answers; the minute before never does.
  let earlierAsked = 0
  mocks.bookChunk.mockImplementation((minute) => {
    const at = DateTime.toEpochMillis(minute)
    if (at === closeMinute)
      return Effect.succeed(Option.some(chunkOf(closeMinute)))
    if (at !== earlier) return Effect.succeed(Option.none())
    earlierAsked += 1
    return Effect.fail("recorded day not served")
  })
  const book = Effect.runSync(makeOrderBookStore(BBCA))
  const unmount = await mount(cursor, book)
  await vi.waitFor(() => expect(book.book()?._tag).toBe("OrderBook"))

  act(() => cursor.seek(earlier))
  expect(book.book()).toBeUndefined()
  await vi.waitFor(() => expect(earlierAsked).toBe(1))
  // Paused on the minute, the failed load leaves nothing shown.
  await vi.waitFor(() => expect(mocks.bookChunk).toHaveBeenCalledTimes(2))
  expect(book.book()).toBeUndefined()
  unmount()
})
