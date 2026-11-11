import { WibDate, isTradingDay } from "@workspace/relay"
import { Effect } from "effect"

// The WIB time of day the Test stage's Market Live clock reads at the start
// of a run: session 1, where silence counts and trades are expected.
const MARKET_TIME = "10:00:00"
const DAY = 86_400_000

// The latest trading day at or before today (WIB), `YYYY-MM-DD`.
const latestTradingDay = (now: number) => {
  for (let back = 0; back < 31; back++) {
    const date = new Date(now + 7 * 3_600_000 - back * DAY)
      .toISOString()
      .slice(0, 10)
    if (Effect.runSync(isTradingDay(WibDate.make(date)))) return date
  }
  throw new Error("No trading day in the last month")
}

/**
 * Milliseconds the Test stage's Market Live clock runs ahead of (or behind)
 * the real one, so the page opens in session 1 of a trading day
 * (apps/dashboard/src/server/market-live/market-clock.ts). Computed once,
 * where playwright.config.ts first loads this, and kept in the environment,
 * so the dashboard and every test worker read the same value.
 */
export const MARKET_CLOCK_OFFSET = Number(
  (process.env.MARKET_LIVE_CLOCK_OFFSET ??= String(
    Date.parse(`${latestTradingDay(Date.now())}T${MARKET_TIME}+07:00`) -
      Date.now()
  ))
)

/** Now on the Test stage's Market Live clock, in epoch ms. */
export const marketNow = () => Date.now() + MARKET_CLOCK_OFFSET

/**
 * How long a trade stays in its candle's merge window after it arrives, as
 * apps/dashboard/src/server/market-live/candles.ts defines it.
 */
export const MERGE_WINDOW = 5_000

/** Milliseconds until `at` on the market clock has passed, 500 ms to spare. */
export const untilMarketTime = (at: number) =>
  Math.max(0, at + 500 - marketNow())
