import { wibTime } from "./clock"
import { ajaibTradeToday } from "./ingest"

/**
 * A tape shaped like VKTR's first 10 minutes on 2026-11-13, the busiest code
 * at the open of the busiest day kept. No capture of that tape is kept, so
 * it is generated to the figures apinrdw/kumora#258 measured from
 * production: 2,309 trades a minute at the peak, about 2,645 sweeps (same
 * side, same second) in the 10 minutes, about 7 prices a minute, a book
 * 45–85 levels a side.
 */
export const VKTR_OPEN = {
  minutes: 10,
  // Trades in each minute, the first the busiest: 23,000 in all.
  tradesPerMinute: [
    2_650, 2_500, 2_400, 2_300, 2_300, 2_250, 2_200, 2_150, 2_150, 2_100,
  ],
  // A sweep averages 8.7 trades (23,000 / 2,645).
  meanSweepTrades: 8.7,
  bookLevels: 65,
  tick: 5,
  firstPrice: 1_000,
} as const

// A seeded generator, so every run replays the same tape (mulberry32).
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

const MINUTE = 60_000

/**
 * VKTR_OPEN's tape as Ajaib TRADE frames for `code`, moved to the 10 minutes
 * that end with the market clock's current minute, numbered from `base` + 1.
 * The current minute's trades spread over its seconds up to `now`, so none
 * is in the future. Sides come in runs inside a second, so the runs are the
 * sweeps; the price walks a tick or two a minute, and each sweep walks up
 * (a buy) or down (a sell) the book from the touch.
 */
export function vktrOpenTape(code: string, base: number, now: number) {
  const random = seeded(272)
  const { tick } = VKTR_OPEN
  const lastMinute = Math.floor(now / MINUTE) * MINUTE
  const frames: Array<string> = []
  let mid = VKTR_OPEN.firstPrice
  let side: "BUY" | "SELL" = "BUY"
  VKTR_OPEN.tradesPerMinute.forEach((count, index) => {
    const minute = lastMinute - (VKTR_OPEN.minutes - 1 - index) * MINUTE
    const seconds = Math.min(60, Math.floor((now - minute) / 1_000) + 1)
    let left = count
    for (let second = 0; second < 60; second++) {
      if (second % 12 === 0) mid += tick * (Math.floor(random() * 3) - 1)
      const inSecond = Math.round(left / (60 - second))
      left -= inSecond
      const at = minute + Math.floor((second * seconds) / 60) * 1_000
      let run = 0
      let walk = 0
      for (let trade = 0; trade < inSecond; trade++) {
        if (run === 0) {
          run =
            1 +
            Math.floor(
              -Math.log(1 - random()) * (VKTR_OPEN.meanSweepTrades - 1)
            )
          if (random() < 0.7) side = side === "BUY" ? "SELL" : "BUY"
          walk = 0
        }
        run--
        if (random() < 0.15) walk++
        const big = random() < 0.02
        frames.push(
          ajaibTradeToday({
            seq: base + frames.length + 1,
            time: wibTime(at),
            ticker: code,
            price:
              side === "BUY"
                ? mid + tick + Math.min(walk, 2) * tick
                : mid - Math.min(walk, 2) * tick,
            lot: big
              ? 1_000 + Math.floor(random() * 9_000)
              : Math.max(1, Math.floor(Math.exp(random() * 6))),
            type: side,
          })
        )
      }
    }
  })
  return frames
}

/**
 * A whole Ajaib book for `code` at `at`: VKTR_OPEN.bookLevels levels a side
 * from the touch around `mid`, seeded by `seed`.
 */
export function vktrBook(code: string, mid: number, at: number, seed: number) {
  const random = seeded(seed)
  const levels = (from: number, step: number) =>
    Array.from({ length: VKTR_OPEN.bookLevels }, (_, level) => ({
      num: 1 + Math.floor(random() * 80),
      price: from + level * step,
      lot: Math.floor(200 + random() * 20_000 * (1 + level / 10)),
    }))
  return JSON.stringify({
    ticker: code,
    is_initial: "true",
    buy: levels(mid, -VKTR_OPEN.tick),
    sell: levels(mid + VKTR_OPEN.tick, VKTR_OPEN.tick),
    updateTime: at,
  })
}
