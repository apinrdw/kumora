// The hero's Quote: last price and the fallback previous close from the newest RG
// trade, the rest from `liveprice`. Free of `effect`, because the browser's reducer
// folds trades with it too.
import { isSymbol } from "@/domain/symbol-guard"
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { LiveQuote, Trade } from "@/domain/trade"

import { REGULAR_BOARD, SHARES_PER_LOT } from "./exchange"

import type { RawLivePrice } from "./stockbit"
import { tradingDay } from "./trading-day"

const QUOTE_WRITE_MS = 30_000
/** `MAX_SYMBOLS` in apps/stockbit-relay-extension/src/protocol.ts is a copy, and names this. */
export const MAX_WALL_COVERAGE = 50
/** A client socket's tag: this, then its symbol. */
export const SYMBOL_TAG = "sym:"

export const NO_QUOTE: LiveQuote = {
  last: null,
  prev: null,
  open: null,
  high: null,
  low: null,
  avg: null,
  volumeLot: null,
  value: null,
  freq: null,
}

/** What `symbol_state` keeps of the newest RG trade. */
export type LastRg = {
  readonly price: number
  readonly change: number
  readonly receivedAt: IsoDateTime
}

/** A symbol's `liveprice` totals. Figures are cumulative for the day; `volume` is in shares. */
export type LiveTotals = {
  readonly day: string
  readonly prev: number | null
  readonly open: number | null
  readonly high: number | null
  readonly low: number | null
  readonly avg: number | null
  readonly volume: number | null
  readonly value: number | null
  readonly freq: number | null
  /** `date` of the newest frame folded: the match time, which orders frames. */
  readonly sourceAt: string | null
  /** When the figures last changed. */
  readonly asOf: IsoDateTime
}

type Figures = Omit<LiveTotals, "day" | "sourceAt" | "asOf">

const NO_FIGURES: Figures = {
  prev: null,
  open: null,
  high: null,
  low: null,
  avg: null,
  volume: null,
  value: null,
  freq: null,
}

const FIGURES = Object.keys(NO_FIGURES) as Array<keyof Figures>

/** A field absent from the frame keeps its figure. */
const mergeFigures = (raw: RawLivePrice, base: Figures): Figures => ({
  prev: raw.prev ?? base.prev,
  open: raw.open ?? base.open,
  high: raw.high ?? base.high,
  low: raw.low ?? base.low,
  avg: raw.average ?? base.avg,
  volume: raw.volume ?? base.volume,
  value: raw.value ?? base.value,
  freq: raw.frequency ?? base.freq,
})

/**
 * Folds one frame into the symbol's totals. Null when the frame is not from the relay's day: a resend of yesterday's,
 * or one ahead of the trade that sets or clears the day, which the next frame corrects. Null too when it is older than the
 * totals: every Stockbit tab forwards `liveprice`, so a delayed frame can follow a newer one. A frame with no `date`
 * cannot be ordered and folds.
 */
export const foldLivePrice = (
  held: LiveTotals | null,
  raw: RawLivePrice,
  day: string | null,
  receivedAt: IsoDateTime
): { readonly totals: LiveTotals; readonly changed: boolean } | null => {
  // `date` is WIB wall clock, so its first ten characters are the day.
  const frameDay = raw.date?.slice(0, 10) ?? tradingDay(receivedAt)
  if (frameDay !== day) return null
  const base = held?.day === frameDay ? held : null
  // Compared as text: `date` is always +07:00, with up to six fractional digits that Date.parse would cut to three.
  if (raw.date !== null && base?.sourceAt != null && raw.date < base.sourceAt)
    return null
  const figures = mergeFigures(raw, base ?? NO_FIGURES)
  const changed = base === null || FIGURES.some((k) => figures[k] !== base[k])
  return {
    totals: {
      day: frameDay,
      ...figures,
      sourceAt: raw.date ?? base?.sourceAt ?? null,
      asOf: changed ? receivedAt : base.asOf,
    },
    changed,
  }
}

/** `liveprice`'s own last price is never read, and NG sets neither last nor prev. */
export const quoteOf = (
  rg: LastRg | null,
  totals: LiveTotals | null
): LiveQuote => ({
  last: rg?.price ?? null,
  prev: totals?.prev ?? (rg ? rg.price - rg.change : null),
  open: totals?.open ?? null,
  high: totals?.high ?? null,
  low: totals?.low ?? null,
  avg: totals?.avg ?? null,
  volumeLot: totals?.volume == null ? null : totals.volume / SHARES_PER_LOT,
  value: totals?.value ?? null,
  freq: totals?.freq ?? null,
})

/** The newest RG trade of a batch in arrival order. */
export const lastRgTrade = (trades: ReadonlyArray<Trade>): Trade | null =>
  [...trades].reverse().find((t) => t.board === REGULAR_BOARD) ?? null

/** What a batch of trades does to a quote. The same object when it does nothing. */
export const applyTrades = (
  quote: LiveQuote,
  trades: ReadonlyArray<Trade>
): LiveQuote => {
  const rg = lastRgTrade(trades)
  if (rg === null) return quote
  return {
    ...quote,
    last: rg.price,
    prev: quote.prev ?? rg.price - rg.change,
  }
}

export const shouldWriteQuote = (
  now: number,
  writtenAt: number | null
): boolean => writtenAt === null || now - writtenAt >= QUOTE_WRITE_MS

/** The symbols to ask `liveprice` for: the open client sockets' tags, then the watched symbols. */
export const openSymbols = (tags: ReadonlyArray<string>): Array<Symbol> => [
  ...new Set(
    tags
      .filter((tag) => tag.startsWith(SYMBOL_TAG))
      .map((tag) => tag.slice(SYMBOL_TAG.length))
      .filter(isSymbol)
  ),
]

export const wallCoverageFrom = (
  tags: ReadonlyArray<string>,
  watched: ReadonlyArray<Symbol> = []
): Array<Symbol> => {
  return [...new Set(openSymbols(tags).sort().concat(watched))].slice(
    0,
    MAX_WALL_COVERAGE
  )
}
