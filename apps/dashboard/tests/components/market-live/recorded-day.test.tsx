// @vitest-environment happy-dom
import type * as Client from "@workspace/client"
import {
  StockCode,
  WibDate,
  type BookChunk,
  type OrderBook,
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
const MINUTE = 60_000

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

test("a book chunk whose load failed is asked for again when the cursor visits its minute again", async () => {
  const cursor = makeReplayCursor(replayDay(DAY, []))
  const closeMinute = Math.floor(cursor.state().at / MINUTE) * MINUTE
  // The close minute's chunk: the relay's first answer fails, the next is the
  // chunk; any other minute has no book.
  let closeAsked = 0
  mocks.bookChunk.mockImplementation((minute) => {
    if (DateTime.toEpochMillis(minute) !== closeMinute)
      return Effect.succeed(Option.none())
    closeAsked += 1
    return closeAsked === 1
      ? Effect.fail("recorded day not served")
      : Effect.succeed(
          Option.some({
            code: BBCA,
            minute: DateTime.makeUnsafe(closeMinute),
            start: bookOf(closeMinute),
            deltas: [],
          })
        )
  })
  const book = makeOrderBookStore(BBCA)
  const candles = makeCandleStore(BBCA)
  const dayStates = makeDayStateStore()
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
  await act(() => root.render(<Harness />))
  await vi.waitFor(() => expect(closeAsked).toBe(1))
  expect(book.book()).toBeUndefined()

  // Away to the minute before, then back.
  act(() => cursor.seek(closeMinute - MINUTE))
  act(() => cursor.seek(closeMinute))
  await vi.waitFor(() => expect(book.book()?._tag).toBe("OrderBook"))
  expect(closeAsked).toBe(2)
  act(() => root.unmount())
})
