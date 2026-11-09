// Decision: a full day for the bounded-memory tests is 900 codes trading
// every minute from the 08:58 match to post-trading's end, about 400,000
// candles: more codes than trade on a busy day, each in every minute
// (CODING_STANDARDS.md, "Bounded memory on a Worker").
export const FULL_DAY_CODES = 900
export const FULL_DAY_MINUTES = 438
