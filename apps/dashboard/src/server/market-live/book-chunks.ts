// Each code's order book as it was served, one chunk per code per minute
// (spec apinrdw/kumora#138, "Storage and cost"): the book in force when the
// minute began, then every served frame in it as the parts that changed. A
// recorded day's page replays a chunk to its cursor (`bookAt` in
// @workspace/relay). Time is read only through Effect's Clock.
import {
  encodeBookChunk,
  type BookDelta,
  type OrderBook,
  type StockCode,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import type { StoredChunk } from "./day-store.ts"

const MINUTE = 60_000

// Decision: a minute's chunk is written once the clock is 5 s past its end,
// so a frame the relay delivers late still lands in it. A frame later than
// that joins the code's next chunk (a chunk is written once), and a frame
// older than the open chunk's minute joins the open chunk.
const SETTLE = 5_000

interface Open {
  readonly minute: number
  readonly start: OrderBook | undefined
  readonly deltas: Array<BookDelta>
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The parts of `book` that differ from `before`; every part when there is no
// book before it.
const deltaOf = (before: OrderBook | undefined, book: OrderBook): BookDelta => {
  const delta: {
    -readonly [K in keyof BookDelta]: BookDelta[K]
  } = { at: book.at }
  if (before?.provenance !== book.provenance) delta.provenance = book.provenance
  if (before === undefined || !same(before.bids, book.bids))
    delta.bids = book.bids
  if (before === undefined || !same(before.offers, book.offers))
    delta.offers = book.offers
  if (before?.bidLots !== book.bidLots) delta.bidLots = book.bidLots
  if (before?.offerLots !== book.offerLots) delta.offerLots = book.offerLots
  if (
    book.previousClose !== undefined &&
    before?.previousClose !== book.previousClose
  )
    delta.previousClose = book.previousClose
  return delta
}

const minuteOf = (time: DateTime.Utc) =>
  Math.floor(DateTime.toEpochMillis(time) / MINUTE) * MINUTE

export const makeBookChunks = Effect.sync(() => {
  // The book each code last served, and its chunk still taking frames.
  const last = new Map<StockCode, OrderBook>()
  const open = new Map<StockCode, Open>()
  // Each code's newest minute whose chunk is closed.
  const closedThrough = new Map<StockCode, number>()
  let closed: Array<{ readonly code: StockCode; readonly open: Open }> = []

  const close = (code: StockCode, held: Open) => {
    closed.push({ code, open: held })
    closedThrough.set(code, held.minute)
    open.delete(code)
  }

  // A book viewers were sent.
  const record = (book: OrderBook) =>
    Effect.sync(() => {
      const through = closedThrough.get(book.code)
      const minute = Math.max(
        minuteOf(book.at),
        through === undefined ? -Infinity : through + MINUTE
      )
      let held = open.get(book.code)
      if (held !== undefined && minute > held.minute) {
        close(book.code, held)
        held = undefined
      }
      if (held === undefined) {
        held = { minute, start: last.get(book.code), deltas: [] }
        open.set(book.code, held)
      }
      held.deltas.push(deltaOf(last.get(book.code), book))
      last.set(book.code, book)
    })

  // Every chunk whose minute is over by `now`, encoded; at the seal, every
  // open one too.
  const take = Effect.fnUntraced(function* (final: boolean) {
    const now = yield* Clock.currentTimeMillis
    for (const [code, held] of open)
      if (final || held.minute + MINUTE + SETTLE <= now) close(code, held)
    const taken = closed
    closed = []
    const chunks: Array<StoredChunk> = []
    for (const { code, open: held } of taken)
      chunks.push({
        code,
        minute: held.minute,
        chunk: yield* encodeBookChunk({
          code,
          minute: DateTime.makeUnsafe(held.minute),
          ...(held.start === undefined ? {} : { start: held.start }),
          deltas: held.deltas,
        }),
      })
    return chunks
  })

  const hasOpen = Effect.sync(() => open.size > 0 || closed.length > 0)

  // A restarted object's latest stored chunk per code, replayed to its end:
  // the next chunk starts from that book, a minute after the stored one.
  const restore = (
    latest: ReadonlyArray<{ readonly minute: number; readonly book: OrderBook }>
  ) =>
    Effect.sync(() => {
      for (const { minute, book } of latest) {
        last.set(book.code, book)
        closedThrough.set(book.code, minute)
      }
    })

  return { record, take, hasOpen, restore }
})
