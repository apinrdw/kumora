// Each stock code's order book (spec apinrdw/kumora#138, "Order book" and
// "Starting values"): Stockbit `order_book` v1 frames (wrapper case 10, one
// full side per frame) and Ajaib `ORDER_BOOK_CUSTOM` frames (a snapshot, then
// per-level deltas). The last book per code is kept for snapshots. Stockbit's
// is served while Stockbit is live, Ajaib's otherwise, each falling back to
// the other when it has none. Time is read only through Effect's Clock.
import {
  BOOK_DEPTH,
  StockCode,
  wibDateAt,
  type BookLevel,
  type IndexHasNoBook,
  type OrderBook,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import { fieldReader, messagesAt, textOf } from "./stockbit.ts"
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
const sideBookOf = (body: string) => {
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
      levels.push({ price: price!, lots: shares! / 100, orders: orders! })
  }
  return { side, book: { levels, lots: Number(totals[1]) / 100 } }
}

const stockbitSideOf = (bytes: Uint8Array) => {
  const read = fieldReader(bytes)
  if (read === undefined) return undefined
  const text = (number: number) => textOf(read(number))
  const code = text(Field.stockCode)
  const parsed = sideBookOf(text(Field.body) ?? "")
  const at = Option.getOrUndefined(
    DateTime.make(text(Field.datetime) ?? "").pipe(Option.map(DateTime.toUtc))
  )
  if (code === undefined || !isStockCode(code) || !parsed || !at)
    return undefined
  return { code, side: parsed.side, book: { ...parsed.book, at } }
}

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

// The later of its sides' times is the book's.
interface StockbitBook {
  bid: SideBook | undefined
  offer: SideBook | undefined
  at: DateTime.Utc
  version: number
}

const best = (
  levels: Iterable<BookLevel>,
  side: Side
): ReadonlyArray<BookLevel> =>
  [...levels]
    .sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price))
    .slice(0, BOOK_DEPTH)

const lotsOf = (levels: Iterable<BookLevel>) => {
  let lots = 0
  for (const level of levels) lots += level.lots
  return lots
}

const applyLevels = (
  held: Map<number, BookLevel>,
  levels: ReadonlyArray<typeof AjaibLevel.Type>
) => {
  for (const { price, lot, num } of levels) {
    if (lot > 0) held.set(price, { price, lots: lot, orders: num })
    else held.delete(price)
  }
}

export const makeOrderBooks = (date: WibDate) =>
  Effect.sync(() => {
    const stockbit = new Map<StockCode, StockbitBook>()
    const ajaib = new Map<StockCode, AjaibBook>()
    const previous = new Map<StockCode, number>()
    const indices = new Set<StockCode>()
    // Codes whose books took a frame since the last delta.
    let changed = new Set<StockCode>()
    // What each code's served book was when viewers were last sent it.
    const sent = new Map<StockCode, string>()
    let servedLive: boolean | undefined
    let version = 0

    const build = (
      code: StockCode,
      provenance: OrderBook["provenance"]
    ): OrderBook | undefined => {
      const close = previous.get(code)
      const extra = close === undefined ? {} : { previousClose: close }
      if (provenance === "Stockbit") {
        const book = stockbit.get(code)
        if (book === undefined) return undefined
        return {
          _tag: "OrderBook",
          code,
          bids: best(book.bid?.levels ?? [], "bid"),
          offers: best(book.offer?.levels ?? [], "offer"),
          bidLots: book.bid?.lots ?? 0,
          offerLots: book.offer?.lots ?? 0,
          at: book.at,
          provenance,
          ...extra,
        }
      }
      const book = ajaib.get(code)
      if (book === undefined) return undefined
      return {
        _tag: "OrderBook",
        code,
        bids: best(book.bids.values(), "bid"),
        offers: best(book.offers.values(), "offer"),
        bidLots: lotsOf(book.bids.values()),
        offerLots: lotsOf(book.offers.values()),
        at: book.at,
        provenance,
        ...extra,
      }
    }

    // What a served book is made of: a different key means viewers need it.
    const keyOf = (code: StockCode, book: OrderBook) =>
      `${book.provenance}:${(book.provenance === "Stockbit" ? stockbit : ajaib).get(code)?.version}:${book.previousClose}`

    const served = (code: StockCode, stockbitLive: boolean) => {
      const [first, second] = stockbitLive
        ? (["Stockbit", "Ajaib"] as const)
        : (["Ajaib", "Stockbit"] as const)
      return build(code, first) ?? build(code, second)
    }

    // A change of Stockbit's liveness can switch every code Ajaib has a book
    // of; codes without one keep Stockbit's.
    const switched = (stockbitLive: boolean) =>
      servedLive !== stockbitLive && ajaib.size > 0

    const stockbitFrames = Effect.fnUntraced(function* (
      frames: ReadonlyArray<Uint8Array>
    ) {
      for (const bytes of frames.flatMap((frame) =>
        messagesAt(frame, ORDERBOOK)
      )) {
        const side = stockbitSideOf(bytes)
        if (side === undefined || (yield* wibDateAt(side.book.at)) !== date)
          continue
        const held = stockbit.get(side.code)
        // Both connections carry each side, so one may deliver a frame the
        // other already applied over: not newer than the side held, it
        // changes nothing.
        const heldSide = held?.[side.side]
        if (
          heldSide !== undefined &&
          !DateTime.isGreaterThan(side.book.at, heldSide.at)
        )
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
      applyLevels(book.bids, buy ?? [])
      applyLevels(book.offers, sell ?? [])
      book.at = at
      book.version = ++version
      ajaib.set(code, book)
      changed.add(code)
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
    const bookOf = (
      code: StockCode,
      stockbitLive: boolean
    ): Effect.Effect<OrderBook | IndexHasNoBook | undefined> =>
      Effect.sync(() =>
        indices.has(code)
          ? { _tag: "IndexHasNoBook", code }
          : served(code, stockbitLive)
      )

    const hasChanges = (stockbitLive: boolean) =>
      Effect.sync(() => changed.size > 0 || switched(stockbitLive))

    // Every code's served book that changed since viewers were last sent it.
    const takeChanged = (stockbitLive: boolean) =>
      Effect.sync(() => {
        const codes = changed
        changed = new Set()
        if (switched(stockbitLive))
          for (const code of ajaib.keys()) codes.add(code)
        servedLive = stockbitLive
        const books: Array<OrderBook> = []
        for (const code of codes) {
          const book = served(code, stockbitLive)
          if (book === undefined) continue
          const key = keyOf(code, book)
          if (sent.get(code) === key) continue
          sent.set(code, key)
          books.push(book)
        }
        return books
      })

    // A restarted object's last served book of a code, as its source's book:
    // the next frames build on it. An Ajaib book keeps only the levels served.
    const restore = (book: OrderBook) =>
      Effect.sync(() => {
        if (book.previousClose !== undefined)
          previous.set(book.code, book.previousClose)
        if (book.provenance === "Stockbit") {
          stockbit.set(book.code, {
            bid: { levels: book.bids, lots: book.bidLots, at: book.at },
            offer: { levels: book.offers, lots: book.offerLots, at: book.at },
            at: book.at,
            version: ++version,
          })
          return
        }
        ajaib.set(book.code, {
          bids: new Map(book.bids.map((level) => [level.price, level])),
          offers: new Map(book.offers.map((level) => [level.price, level])),
          at: book.at,
          version: ++version,
        })
      })

    return {
      restore,
      stockbitFrames,
      ajaibFrames,
      livePrice,
      bookOf,
      hasChanges,
      takeChanged,
    }
  })
