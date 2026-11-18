// What the Book readout and the order book radar's scanner share about book
// readings (spec apinrdw/kumora#517): the disclaimer at their foot and the
// lowest previous close readings are shown for.
import { Effect } from "effect"

export const DISCLAIMER =
  "Book readings describe liquidity and pressure in the order book. They don't predict price and aren't advice to buy or sell."

// Decision: a code whose previous close is Rp10 or less shows no readings:
// one tick there moves the price 10–100%. See spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes".
export const LOWEST_READ_CLOSE = 10

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
