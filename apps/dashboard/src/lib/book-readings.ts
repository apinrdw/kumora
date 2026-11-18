// What the Book readout and the order book radar's scanner share about book
// readings (spec apinrdw/kumora#517): the disclaimer at their foot and the
// lowest previous close readings are shown for.

export const DISCLAIMER =
  "Book readings describe liquidity and pressure in the order book. They don't predict price and aren't advice to buy or sell."

// Decision: a code whose previous close is Rp10 or less shows no readings:
// one tick there moves the price 10–100%. See spec apinrdw/kumora#517,
// "Ticks, limits and excluded codes".
export const LOWEST_READ_CLOSE = 10
