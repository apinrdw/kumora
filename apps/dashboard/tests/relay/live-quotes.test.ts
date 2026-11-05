import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Trade } from "@/domain/trade"
import { LiveQuotes } from "@/relay/live-quotes"
import { lastRgTrade } from "@/relay/quote"
import type { RawLivePrice } from "@/relay/stockbit"
import { lastRgOf, relayStore } from "@/relay/store"
import type { RelayStore } from "@/relay/store"

import { sqlStorage } from "../support/sql-storage"

const AMMN = Symbol.make("AMMN")
const BBCA = Symbol.make("BBCA")
const DAY = "2026-10-29"
const NOW = Date.parse("2026-10-29T06:30:10.000Z")

const raw = (date: string, volume: number): RawLivePrice => ({
  stock: "BBCA",
  date,
  prev: null,
  open: null,
  high: null,
  low: null,
  average: null,
  volume,
  value: null,
  frequency: null,
  lastprice: null,
  verb: null,
  quantity: null,
  orderNumber: null,
  matchNumber: null,
})

const newStore = () => {
  const store = relayStore(sqlStorage())
  store.create()
  return store
}

describe("LiveQuotes across a wake", () => {
  test("a frame older than the persisted totals is still rejected", () => {
    const store = newStore()
    const before = new LiveQuotes(store)
    const newer = raw("2026-10-29T13:30:05.2+07:00", 200_000)
    expect(before.fold(BBCA, newer, DAY, NOW)).toBe(true)

    const woken = new LiveQuotes(store)
    const delayed = raw("2026-10-29T13:30:01.1+07:00", 100_000)
    expect(woken.fold(BBCA, delayed, DAY, NOW + 60_000)).toBe(false)
    expect(woken.served(BBCA, DAY)?.quote.volumeLot).toBe(2000)
  })

  test("a same-figures frame still advances the stamp a delayed frame meets", () => {
    const quotes = new LiveQuotes(newStore())
    quotes.fold(BBCA, raw("2026-10-29T13:30:01+07:00", 200_000), DAY, NOW)
    quotes.fold(BBCA, raw("2026-10-29T13:30:05+07:00", 200_000), DAY, NOW)
    const delayed = raw("2026-10-29T13:30:03+07:00", 100_000)
    expect(quotes.fold(BBCA, delayed, DAY, NOW)).toBe(false)
    expect(quotes.served(BBCA, DAY)?.quote.volumeLot).toBe(2000)
  })
})

describe("a live_quote row across a wake", () => {
  const SECOND = 1000
  const at = (ms: number) => new Date(NOW + ms).toISOString()
  const frame = (volume: number) => raw("2026-10-29T13:30:01+07:00", volume)

  test("holds the time the figures changed, not the time it was flushed", () => {
    const store = newStore()
    const before = new LiveQuotes(store)
    before.fold(BBCA, frame(100_000), DAY, NOW)
    before.fold(BBCA, frame(200_000), DAY, NOW + 10 * SECOND)
    before.flush(NOW + 30 * SECOND)

    const woken = new LiveQuotes(store)
    expect(woken.served(BBCA, DAY)?.quote.volumeLot).toBe(2000)
    expect(woken.served(BBCA, DAY)?.asOf).toBe(at(10 * SECOND))
  })

  test("holds its write to one per 30 s from the last write, whatever its as-of", () => {
    const store = newStore()
    const before = new LiveQuotes(store)
    before.fold(BBCA, frame(100_000), DAY, NOW)
    before.fold(BBCA, frame(200_000), DAY, NOW + 10 * SECOND)
    before.flush(NOW + 30 * SECOND)

    const early = new LiveQuotes(store)
    early.fold(BBCA, frame(300_000), DAY, NOW + 59 * SECOND)
    expect(new LiveQuotes(store).served(BBCA, DAY)?.quote.volumeLot).toBe(2000)

    const due = new LiveQuotes(store)
    due.fold(BBCA, frame(400_000), DAY, NOW + 60 * SECOND)
    expect(new LiveQuotes(store).served(BBCA, DAY)?.quote.volumeLot).toBe(4000)
  })
})

describe("a newer frame with unchanged figures", () => {
  const SECOND = 1000
  const FIRST = "2026-10-29T13:30:01+07:00"
  const BETWEEN = "2026-10-29T13:30:03+07:00"
  const NEWER = "2026-10-29T13:30:05+07:00"

  const heldAt = (store: RelayStore) => {
    const quotes = new LiveQuotes(store)
    quotes.fold(BBCA, raw(FIRST, 200_000), DAY, NOW)
    return quotes
  }

  test("reaches the row by the next due flush, and a delayed frame still loses after a wake", () => {
    const store = newStore()
    const before = heldAt(store)
    expect(before.fold(BBCA, raw(NEWER, 200_000), DAY, NOW + SECOND)).toBe(
      false
    )
    before.flush(NOW + 30 * SECOND)

    const woken = new LiveQuotes(store)
    const delayed = raw(BETWEEN, 100_000)
    expect(woken.fold(BBCA, delayed, DAY, NOW + 31 * SECOND)).toBe(false)
    expect(woken.served(BBCA, DAY)?.quote.volumeLot).toBe(2000)
  })

  test("waits out the 30 s, and leaves the quote's as-of alone", () => {
    const store = newStore()
    const quotes = heldAt(store)
    quotes.fold(BBCA, raw(NEWER, 200_000), DAY, NOW + SECOND)

    quotes.flush(NOW + 30 * SECOND - 1)
    expect(store.storedQuote(BBCA)?.totals.sourceAt).toBe(FIRST)

    quotes.flush(NOW + 30 * SECOND)
    expect(store.storedQuote(BBCA)).toMatchObject({
      totals: { sourceAt: NEWER, asOf: new Date(NOW).toISOString() },
      writtenAt: NOW + 30 * SECOND,
    })
  })

  test("writes at once when the 30 s have passed", () => {
    const store = newStore()
    const quotes = heldAt(store)
    expect(quotes.fold(BBCA, raw(NEWER, 200_000), DAY, NOW + 30 * SECOND)).toBe(
      false
    )
    expect(store.storedQuote(BBCA)?.totals.sourceAt).toBe(NEWER)
  })

  test("an unchanged stamp writes nothing, however late", () => {
    const store = newStore()
    const quotes = heldAt(store)
    quotes.fold(BBCA, raw(FIRST, 200_000), DAY, NOW + 60 * SECOND)
    quotes.flush(NOW + 60 * SECOND)
    expect(store.storedQuote(BBCA)?.writtenAt).toBe(NOW)
  })
})

describe("the as-of of a symbol with an RG price and no totals", () => {
  const FIRST = IsoDateTime.make("2026-10-29T02:00:00.000Z")
  const LATER = IsoDateTime.make("2026-10-29T06:00:00.000Z")

  const trade = (over: Partial<Trade>): Trade => ({
    symbol: AMMN,
    price: 9000,
    volume: 100,
    value: 900_000,
    side: "buy",
    board: "RG",
    tradeNumber: 1,
    tradedAt: FIRST,
    receivedAt: FIRST,
    change: 50,
    ...over,
  })

  const append = (store: RelayStore, seq: number, one: Trade) =>
    store.appendBatch(
      one.symbol,
      seq,
      DAY,
      one.receivedAt,
      [one],
      lastRgTrade([one])
    )

  const wake = (store: RelayStore) => {
    const quotes = new LiveQuotes(store)
    for (const row of store.symbolStates()) {
      const rg = lastRgOf(row)
      if (rg) quotes.setRg(row.symbol, rg)
    }
    return quotes
  }

  test("is its own trade's, after another symbol trades and a wake", () => {
    const store = newStore()
    append(store, 1, trade({}))
    append(store, 2, trade({ symbol: BBCA, receivedAt: LATER }))
    expect(wake(store).served(AMMN, DAY)?.asOf).toBe(FIRST)
  })

  test("is unmoved by its own NG trade, in one row per symbol", () => {
    const store = newStore()
    append(store, 1, trade({}))
    append(
      store,
      2,
      trade({ board: "NG", price: 7000, tradeNumber: 2, receivedAt: LATER })
    )
    const quotes = wake(store)
    expect(quotes.served(AMMN, DAY)?.asOf).toBe(FIRST)
    expect(quotes.served(AMMN, DAY)?.quote.last).toBe(9000)
    expect(store.symbolStates().toArray()).toHaveLength(1)
  })

  test("gives way to the totals' as-of once a frame has arrived", () => {
    const store = newStore()
    append(store, 1, trade({}))
    const quotes = wake(store)
    quotes.fold(AMMN, raw("2026-10-29T13:00:00+07:00", 100), DAY, NOW)
    expect(quotes.served(AMMN, DAY)?.asOf).toBe(new Date(NOW).toISOString())
  })
})
