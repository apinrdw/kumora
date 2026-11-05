import type { Quote } from "@/domain/quote"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { TapeBackfill } from "@/domain/trade"
import { NO_QUOTE } from "@/relay/quote"
import { tradingDay } from "@/relay/trading-day"

/* All figures are synthetic (DATA DEMO). Timestamps are fixed so SSR and client agree. */

/** The last demo trade: Friday 23 Okt 2026, 15.42 WIB. */
const AS_OF = IsoDateTime.make("2026-10-23T08:42:00Z")

type DemoStock = { symbol: Symbol; tick: number; quote: Quote }

/** A symbol with no fixture trades: the tape's shape with nothing on it. */
export const emptyDemoTape = (symbol: Symbol): TapeBackfill => ({
  symbol,
  seq: 0,
  day: null,
  trades: [],
  offBoard: [],
  quote: NO_QUOTE,
  quoteAsOf: null,
  coverage: [],
  provenance: {
    feed: "stockbit-running-trades",
    source: "none",
    asOf: null,
    freshness: "demo",
  },
  sweeps: [],
  walls: [],
  threshold: {
    symbol,
    threshold: null,
    warmingUp: true,
    prior: "none",
    ordersToday: 0,
    asOf: null,
  },
  wallCoverage: false,
  liveprice: {
    feed: "stockbit-liveprice",
    source: "none",
    asOf: null,
    freshness: "demo",
  },
})

/** Newest first: ticks off the last price, and lots. The newest trade is the hero's last. */
const DEMO_TRADES = [
  { ticks: 0, lots: 12, side: "buy" },
  { ticks: -1, lots: 5, side: "sell" },
  { ticks: 0, lots: 40, side: "buy" },
  { ticks: 1, lots: 8, side: "buy" },
  { ticks: 0, lots: 150, side: "sell" },
  { ticks: -1, lots: 3, side: "sell" },
  { ticks: 0, lots: 25, side: "unspecified" },
  { ticks: 1, lots: 60, side: "buy" },
] as const

const FIRST_TRADE_NUMBER = 40_000
const SECONDS_APART = 37

const demoTape = ({ symbol, quote, tick }: DemoStock): TapeBackfill => ({
  ...emptyDemoTape(symbol),
  seq: DEMO_TRADES.length,
  day: tradingDay(AS_OF),
  trades: DEMO_TRADES.map(({ ticks, lots, side }, i) => {
    const price = quote.last + ticks * tick
    const volume = lots * 100
    const tradedAt = Date.parse(AS_OF) - i * SECONDS_APART * 1000
    return {
      symbol,
      price,
      volume,
      value: price * volume,
      side,
      board: "RG",
      tradeNumber: FIRST_TRADE_NUMBER + DEMO_TRADES.length - i,
      tradedAt: IsoDateTime.make(new Date(tradedAt).toISOString()),
      receivedAt: IsoDateTime.make(new Date(tradedAt + 1000).toISOString()),
      change: price - quote.prev,
    }
  }),
  quote,
  quoteAsOf: AS_OF,
  provenance: {
    feed: "stockbit-running-trades",
    source: "none",
    asOf: AS_OF,
    freshness: "demo",
  },
})

const DEMO_STOCKS: ReadonlyArray<DemoStock> = [
  {
    symbol: Symbol.make("BBRI"),
    tick: 5,
    quote: {
      last: 4880,
      prev: 4790,
      open: 4800,
      high: 4910,
      low: 4790,
      avg: 4862,
      volumeLot: 1_420_000,
      value: 692e9,
      freq: 38_412,
    },
  },
  {
    symbol: Symbol.make("BBCA"),
    tick: 25,
    quote: {
      last: 9275,
      prev: 9175,
      open: 9200,
      high: 9300,
      low: 9175,
      avg: 9248,
      volumeLot: 980_000,
      value: 906e9,
      freq: 41_208,
    },
  },
  {
    symbol: Symbol.make("TLKM"),
    tick: 10,
    quote: {
      last: 2980,
      prev: 2960,
      open: 2960,
      high: 3000,
      low: 2950,
      avg: 2977,
      volumeLot: 1_260_000,
      value: 375e9,
      freq: 29_870,
    },
  },
  {
    symbol: Symbol.make("GOTO"),
    tick: 1,
    quote: {
      last: 68,
      prev: 71,
      open: 71,
      high: 72,
      low: 67,
      avg: 69,
      volumeLot: 38_400_000,
      value: 265e9,
      freq: 52_316,
    },
  },
]

/** The demo tape per symbol, for when the relay is not bound. */
export const DEMO_TAPES: ReadonlyMap<Symbol, TapeBackfill> = new Map(
  DEMO_STOCKS.map((s) => [s.symbol, demoTape(s)])
)
