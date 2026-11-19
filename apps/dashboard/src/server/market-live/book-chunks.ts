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
  MINUTE_MS,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import type { StoredChunk } from "./day-store.ts"
import { chunkSlices } from "./heat-rows.ts"

interface Open {
  readonly minute: number
  readonly start: OrderBook | undefined
  readonly deltas: Array<BookDelta>
}

const same = (a: unknown, b: unknown) =>
  Effect.succeed(JSON.stringify(a) === JSON.stringify(b))

// The parts of `book` that differ from `before`; every part when there is no
// book before it.
const deltaOf = Effect.fnUntraced(function* (
  servedAt: DateTime.Utc,
  before: OrderBook | undefined,
  book: OrderBook
) {
  const delta: {
    -readonly [K in keyof BookDelta]: BookDelta[K]
  } = { servedAt, at: book.at }
  // Every per-side time and sequence number, changed or not: replay replaces
  // them as one group.
  if (book.bidAt !== undefined) delta.bidAt = book.bidAt
  if (book.offerAt !== undefined) delta.offerAt = book.offerAt
  if (book.bidSequence !== undefined) delta.bidSequence = book.bidSequence
  if (book.offerSequence !== undefined) delta.offerSequence = book.offerSequence
  if (before?.provenance !== book.provenance) delta.provenance = book.provenance
  if (before === undefined || !(yield* same(before.bids, book.bids)))
    delta.bids = book.bids
  if (before === undefined || !(yield* same(before.offers, book.offers)))
    delta.offers = book.offers
  if (before?.bidLots !== book.bidLots) delta.bidLots = book.bidLots
  if (before?.offerLots !== book.offerLots) delta.offerLots = book.offerLots
  if (
    book.previousClose !== undefined &&
    before?.previousClose !== book.previousClose
  )
    delta.previousClose = book.previousClose
  return delta
})

export const makeBookChunks = Effect.sync(() => {
  // The book each code last served, and its chunk still taking frames.
  const last = new Map<StockCode, OrderBook>()
  const open = new Map<StockCode, Open>()
  let closed: Array<{ readonly code: StockCode; readonly open: Open }> = []

  const close = (code: StockCode, held: Open) =>
    Effect.sync(() => {
      closed.push({ code, open: held })
      open.delete(code)
    })

  // A book viewers were sent.
  // Decision: a frame joins the chunk of the minute it was served in, by the
  // object's clock, not by the book's as-of, so a code's deltas follow the
  // viewers' timeline. See apinrdw/kumora#157.
  const record = Effect.fnUntraced(function* (book: OrderBook) {
    const now = yield* Clock.currentTimeMillis
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS
    let held = open.get(book.code)
    if (held !== undefined && minute > held.minute) {
      yield* close(book.code, held)
      held = undefined
    }
    if (held === undefined) {
      held = { minute, start: last.get(book.code), deltas: [] }
      open.set(book.code, held)
    }
    held.deltas.push(
      yield* deltaOf(DateTime.makeUnsafe(now), last.get(book.code), book)
    )
    last.set(book.code, book)
  })

  // Every chunk whose minute is over by `now`, encoded; at the seal, every
  // open one too.
  const take = Effect.fnUntraced(function* (final: boolean) {
    const now = yield* Clock.currentTimeMillis
    for (const [code, held] of open)
      if (final || held.minute + MINUTE_MS <= now) yield* close(code, held)
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
        slices: yield* chunkSlices(held),
      })
    return chunks
  })

  // The chunks of `code` not taken yet, oldest first: closed ones, then the
  // open one.
  const held = (code: StockCode) =>
    Effect.sync(() => {
      const chunks = closed
        .filter((entry) => entry.code === code)
        .map((entry) => entry.open)
      const current = open.get(code)
      return current === undefined ? chunks : [...chunks, current]
    })

  const hasOpen = Effect.sync(() => open.size > 0 || closed.length > 0)

  // A restarted object's last stored book per code, replayed to its chunk's
  // end: the next chunk starts from it.
  const restore = (books: ReadonlyArray<OrderBook>) =>
    Effect.sync(() => {
      for (const book of books) last.set(book.code, book)
    })

  return { record, take, held, hasOpen, restore }
})
