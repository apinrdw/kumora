// Each stock code's order book (spec apinrdw/kumora#138, "Order book" and
// "Starting values"): Stockbit `order_book` v1 frames (wrapper case 10, one
// full side per frame) and Ajaib `ORDER_BOOK_CUSTOM` frames (a snapshot, then
// per-level deltas). The last book per code is kept for snapshots. Stockbit's
// is served while Stockbit is live, Ajaib's otherwise, each falling back to
// the other when it has none. Time is read only through Effect's Clock.
import {
  SHARES_PER_LOT,
  BOOK_DEPTH,
  BookLevel,
  StockCode,
  wibDateAt,
  type IndexHasNoBook,
  type OrderBook,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import { newerThanHeld } from "./late-frames.ts"
import { fieldReader, messagesIn, textOf } from "./stockbit.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

const ORDERBOOK = 10

// `Orderbook`'s fields: the body is the pipe-delimited text of one side,
// `datetime` the frame's ISO time with the WIB offset.
const Field = { stockCode: 1, body: 2, datetime: 5 } as const

type Side = "bid" | "offer"

// One side as one frame carried it: every level, its lots in total, and the
// frame's time.
interface SideBook {
  readonly levels: ReadonlyArray<BookLevel>
  readonly lots: number
  readonly at: DateTime.Utc
}

const isStockCode = Schema.is(StockCode)

// `#O|<code>|BID or OFFER|price;orders;shares|…|<epoch s>-<orders>&<shares>`.
// Undefined when the body isn't one.
const sideBookOf = (body: string) =>
  Effect.sync(() => {
    const parts = body.split("|")
    const side: Side | undefined =
      parts[2] === "BID" ? "bid" : parts[2] === "OFFER" ? "offer" : undefined
    const totals = /^\d+-\d+&(\d+)$/.exec(parts.at(-1) ?? "")
    if (parts[0] !== "#O" || side === undefined || totals === null)
      return undefined
    const levels: Array<BookLevel> = []
    for (const part of parts.slice(3, -1)) {
      const [price, orders, shares] = part.split(";").map(Number)
      if (
        !Number.isFinite(price) ||
        !Number.isInteger(orders) ||
        !Number.isFinite(shares)
      )
        return undefined
      if (shares! > 0)
        levels.push({
          price: price!,
          lots: shares! / SHARES_PER_LOT,
          orders: orders!,
        })
    }
    return { side, book: { levels, lots: Number(totals[1]) / SHARES_PER_LOT } }
  })

const stockbitSideOf = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const read = yield* fieldReader(bytes)
  if (read === undefined) return undefined
  const code = yield* textOf(read.get(Field.stockCode))
  const parsed = yield* sideBookOf((yield* textOf(read.get(Field.body))) ?? "")
  const at = Option.getOrUndefined(
    DateTime.make((yield* textOf(read.get(Field.datetime))) ?? "").pipe(
      Option.map(DateTime.toUtc)
    )
  )
  if (code === undefined || !isStockCode(code) || !parsed || !at)
    return undefined
  return { code, side: parsed.side, book: { ...parsed.book, at } }
})

const AjaibLevel = Schema.Struct({
  price: Schema.Finite,
  lot: Schema.Finite,
  num: Schema.Int,
})

// `is_initial` ("true") marks a whole book; otherwise each level given
// replaces its price's, and a level of 0 lots is gone. A trade or PRICE frame
// carries neither side and is skipped.
const AjaibOrderBook = Schema.Struct({
  ticker: StockCode,
  is_initial: Schema.optionalKey(Schema.String),
  buy: Schema.optionalKey(Schema.Array(AjaibLevel)),
  sell: Schema.optionalKey(Schema.Array(AjaibLevel)),
  updateTime: Schema.Finite,
})

const decodeAjaib = Schema.decodeUnknownOption(
  Schema.fromJsonString(AjaibOrderBook)
)

// Ajaib's book of one code, every level by price.
interface AjaibBook {
  bids: Map<number, BookLevel>
  offers: Map<number, BookLevel>
  at: DateTime.Utc
  version: number
}

// One code's whole Ajaib book, encoded, as the day store keeps it.
export interface StoredAjaibBook {
  readonly code: StockCode
  readonly book: string
}

// Decision: an Ajaib book is stored whole, every level and its as-of, one row
// per on-demand code, replaced by each flush that saw it change: Ajaib sends a
// whole book only on subscribing, a restarted object keeps its hibernated
// socket so none comes again, and the served book's 20 levels can't carry the
// deltas on. See apinrdw/kumora#157.
const AjaibBookRecord = Schema.fromJsonString(
  Schema.Struct({
    bids: Schema.Array(BookLevel),
    offers: Schema.Array(BookLevel),
    at: Schema.Finite,
  })
)
const encodeAjaibBook = Schema.encodeEffect(AjaibBookRecord)
const decodeAjaibBook = Schema.decodeUnknownEffect(AjaibBookRecord)

// The later of its sides' times is the book's.
interface StockbitBook {
  bid: SideBook | undefined
  offer: SideBook | undefined
  at: DateTime.Utc
  version: number
}

const best = (levels: Iterable<BookLevel>, side: Side) =>
  Effect.sync((): ReadonlyArray<BookLevel> =>
    [...levels]
      .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price))
      .slice(0, BOOK_DEPTH)
  )

const lotsOf = (levels: Iterable<BookLevel>) =>
  Effect.sync(() => {
    let lots = 0
    for (const level of levels) lots += level.lots
    return lots
  })

const applyLevels = (
  held: Map<number, BookLevel>,
  levels: ReadonlyArray<typeof AjaibLevel.Type>
) =>
  Effect.sync(() => {
    for (const { price, lot, num } of levels) {
      if (lot > 0) held.set(price, { price, lots: lot, orders: num })
      else held.delete(price)
    }
  })

export const makeOrderBooks = (date: WibDate) =>
  Effect.sync(() => {
    const stockbit = new Map<StockCode, StockbitBook>()
    const ajaib = new Map<StockCode, AjaibBook>()
    const previous = new Map<StockCode, number>()
    const indices = new Set<StockCode>()
    // Codes whose books took a frame since the last delta, and whose Ajaib
    // book did since the last flush.
    let changed = new Set<StockCode>()
    let ajaibUnflushed = new Set<StockCode>()
    // What each code's served book was when viewers were last sent it.
    const sent = new Map<StockCode, string>()
    let servedLive: boolean | undefined
    let version = 0

    const build = Effect.fnUntraced(function* (
      code: StockCode,
      provenance: OrderBook["provenance"]
    ) {
      const close = previous.get(code)
      const extra = close === undefined ? {} : { previousClose: close }
      if (provenance === "Stockbit") {
        const book = stockbit.get(code)
        if (book === undefined) return undefined
        const built: OrderBook = {
          _tag: "OrderBook",
          code,
          bids: yield* best(book.bid?.levels ?? [], "bid"),
          offers: yield* best(book.offer?.levels ?? [], "offer"),
          bidLots: book.bid?.lots ?? 0,
          offerLots: book.offer?.lots ?? 0,
          at: book.at,
          provenance,
          ...extra,
        }
        return built
      }
      const book = ajaib.get(code)
      if (book === undefined) return undefined
      const built: OrderBook = {
        _tag: "OrderBook",
        code,
        bids: yield* best(book.bids.values(), "bid"),
        offers: yield* best(book.offers.values(), "offer"),
        bidLots: yield* lotsOf(book.bids.values()),
        offerLots: yield* lotsOf(book.offers.values()),
        at: book.at,
        provenance,
        ...extra,
      }
      return built
    })

    // What a served book is made of: a different key means viewers need it.
    const keyOf = (code: StockCode, book: OrderBook) =>
      Effect.sync(
        () =>
          `${book.provenance}:${(book.provenance === "Stockbit" ? stockbit : ajaib).get(code)?.version}:${book.previousClose}`
      )

    const served = Effect.fnUntraced(function* (
      code: StockCode,
      stockbitLive: boolean
    ) {
      const [first, second] = stockbitLive
        ? (["Stockbit", "Ajaib"] as const)
        : (["Ajaib", "Stockbit"] as const)
      return (yield* build(code, first)) ?? (yield* build(code, second))
    })

    // A change of Stockbit's liveness can switch every code Ajaib has a book
    // of; codes without one keep Stockbit's.
    const switched = (stockbitLive: boolean) =>
      Effect.sync(() => servedLive !== stockbitLive && ajaib.size > 0)

    const stockbitFrames = Effect.fnUntraced(function* (
      frames: ReadonlyArray<Uint8Array>
    ) {
      for (const bytes of yield* messagesIn(frames, ORDERBOOK)) {
        const side = yield* stockbitSideOf(bytes)
        if (side === undefined || (yield* wibDateAt(side.book.at)) !== date)
          continue
        const held = stockbit.get(side.code)
        // Not newer than the side held, the other connection delivering
        // late, it changes nothing.
        if (!(yield* newerThanHeld(side.book.at, held?.[side.side]?.at)))
          continue
        stockbit.set(side.code, {
          bid: side.side === "bid" ? side.book : held?.bid,
          offer: side.side === "offer" ? side.book : held?.offer,
          at:
            held === undefined
              ? side.book.at
              : DateTime.max(held.at, side.book.at),
          version: ++version,
        })
        changed.add(side.code)
      }
    })

    // One frame's book change, or undefined for a frame without a side (a
    // trade or PRICE frame) or from another trading day.
    const ajaibFrameOf = Effect.fnUntraced(function* (frame: string) {
      const decoded = decodeAjaib(frame)
      if (Option.isNone(decoded)) return undefined
      const { ticker: code, is_initial, buy, sell, updateTime } = decoded.value
      if (buy === undefined && sell === undefined) return undefined
      const at = DateTime.makeUnsafe(updateTime)
      if ((yield* wibDateAt(at)) !== date) return undefined
      return { code, initial: is_initial === "true", buy, sell, at }
    })

    const ajaibFrame = Effect.fnUntraced(function* (frame: string) {
      const change = yield* ajaibFrameOf(frame)
      if (change === undefined) return
      const { code, initial, buy, sell, at } = change
      const held = ajaib.get(code)
      // Both connections carry the same book, so one may deliver a frame the
      // other already applied over: older than the book, it is dropped.
      if (held !== undefined && DateTime.isLessThan(at, held.at)) return
      const book =
        held === undefined || initial
          ? { bids: new Map(), offers: new Map(), at, version: 0 }
          : held
      yield* applyLevels(book.bids, buy ?? [])
      yield* applyLevels(book.offers, sell ?? [])
      book.at = at
      book.version = ++version
      ajaib.set(code, book)
      changed.add(code)
      ajaibUnflushed.add(code)
    })

    const ajaibFrames = (frames: ReadonlyArray<string>) =>
      Effect.forEach(frames, ajaibFrame, { discard: true })

    const livePrice = (price: LivePrice) =>
      Effect.sync(() => {
        if (price.isIndex) indices.add(price.code)
        if (price.previous === undefined) return
        if (previous.get(price.code) === price.previous) return
        previous.set(price.code, price.previous)
        changed.add(price.code)
      })

    // The book a viewer selecting `code` starts from.
    const bookOf = Effect.fnUntraced(function* (
      code: StockCode,
      stockbitLive: boolean
    ): Effect.fn.Return<OrderBook | IndexHasNoBook | undefined> {
      return indices.has(code)
        ? { _tag: "IndexHasNoBook", code }
        : yield* served(code, stockbitLive)
    })

    const hasChanges = Effect.fnUntraced(function* (stockbitLive: boolean) {
      return changed.size > 0 || (yield* switched(stockbitLive))
    })

    // Every code's served book that changed since viewers were last sent it.
    const takeChanged = Effect.fnUntraced(function* (stockbitLive: boolean) {
      const codes = changed
      changed = new Set()
      if (yield* switched(stockbitLive))
        for (const code of ajaib.keys()) codes.add(code)
      servedLive = stockbitLive
      const books: Array<OrderBook> = []
      for (const code of codes) {
        const book = yield* served(code, stockbitLive)
        if (book === undefined) continue
        const key = yield* keyOf(code, book)
        if (sent.get(code) === key) continue
        sent.set(code, key)
        books.push(book)
      }
      return books
    })

    // A restarted object's last served book of a code: its previous close,
    // and, from Stockbit, the sides the next frames replace whole. An Ajaib
    // book comes back whole through `restoreAjaib`, not from its 20 served
    // levels.
    const restore = (book: OrderBook) =>
      Effect.sync(() => {
        if (book.previousClose !== undefined)
          previous.set(book.code, book.previousClose)
        if (book.provenance !== "Stockbit") return
        stockbit.set(book.code, {
          bid: { levels: book.bids, lots: book.bidLots, at: book.at },
          offer: { levels: book.offers, lots: book.offerLots, at: book.at },
          at: book.at,
          version: ++version,
        })
      })

    // A restarted object's Ajaib books, whole, as the store kept them.
    const restoreAjaib = Effect.fnUntraced(function* (
      stored: ReadonlyArray<StoredAjaibBook>
    ) {
      for (const { code, book } of stored) {
        const { bids, offers, at } = yield* decodeAjaibBook(book)
        ajaib.set(code, {
          bids: new Map(bids.map((level) => [level.price, level])),
          offers: new Map(offers.map((level) => [level.price, level])),
          at: DateTime.makeUnsafe(at),
          version: ++version,
        })
      }
    })

    // What a flush writes: the whole Ajaib book of every code whose changed
    // since the last flush.
    const takeAjaibBooks = Effect.gen(function* () {
      const codes = ajaibUnflushed
      ajaibUnflushed = new Set()
      const books: Array<StoredAjaibBook> = []
      for (const code of codes) {
        const book = ajaib.get(code)
        if (book === undefined) continue
        books.push({
          code,
          book: yield* encodeAjaibBook({
            bids: [...book.bids.values()],
            offers: [...book.offers.values()],
            at: DateTime.toEpochMillis(book.at),
          }),
        })
      }
      return books
    })

    const hasUnflushedAjaib = Effect.sync(() => ajaibUnflushed.size > 0)

    return {
      restore,
      restoreAjaib,
      stockbitFrames,
      ajaibFrames,
      livePrice,
      bookOf,
      hasChanges,
      takeChanged,
      takeAjaibBooks,
      hasUnflushedAjaib,
    }
  })
