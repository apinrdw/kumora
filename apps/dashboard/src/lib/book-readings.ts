// What the Book readout and the order book radar's scanner share about book
// readings (spec apinrdw/kumora#517): the disclaimer at their foot, the
// lowest previous close readings are shown for, and a heavy side's words.
import type { HeavySide } from "@workspace/relay"
import { Effect } from "effect"

export const DISCLAIMER =
  "Book readings describe liquidity and pressure in the order book. They don't predict price and aren't advice to buy or sell."

// A code whose previous close is Rp10 or less shows no readings:
// one tick there moves the price 10–100%. See spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes".
export const LOWEST_READ_CLOSE = 10

// The side a lopsided book leans to, and how its heavy side's lots are held
// (glossary **Heavy side**), as the Book readout, the heavy side chip and an
// alert's title word them.
export const LEANS: Readonly<Record<HeavySide["side"], string>> = {
  bid: "Bid-heavy",
  offer: "Offer-heavy",
}
export const ORDERS: Readonly<Record<HeavySide["orders"], string>> = {
  big: "big orders",
  small: "small orders",
}

// A code's last price and previous close, as a page holds them.
export interface CodePrices {
  readonly last: number | undefined
  readonly previousClose: number | undefined
}

// A code's previous close, or its last price while none is known: Rp10 or
// less keeps it off the scanner, out of the alerts and out of the readout.
export const isCheap = (prices: CodePrices | undefined) =>
  Effect.sync(() => {
    const close = prices?.previousClose ?? prices?.last
    return close !== undefined && close <= LOWEST_READ_CLOSE
  })
