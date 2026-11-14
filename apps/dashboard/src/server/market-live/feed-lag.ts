// How far behind the exchange each feed's running trades reach the trading
// day (spec apinrdw/kumora#235, "Feed lag" and "The per-minute log"). Time is
// read only through Effect's Clock.
import { type Feed, type RunningTrade, MINUTE_MS } from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

// One running trade's first relayed arrival on a feed.
export interface TimedTrade {
  readonly feed: Feed
  // When it arrived, in epoch ms on the Clock.
  readonly arrived: number
  // `arrived` minus the exchange's trade time the frame carries, in ms.
  readonly lag: number
}

// `trades` arriving now on `feed`, timed.
export const timeTrades = Effect.fnUntraced(function* (
  feed: Feed,
  trades: ReadonlyArray<RunningTrade>
) {
  const arrived = yield* Clock.currentTimeMillis
  return trades.map((trade): TimedTrade => ({
    feed,
    arrived,
    lag: arrived - DateTime.toEpochMillis(trade.time),
  }))
})

// The nearest-rank `p`th percentile of ascending `sorted`, never empty.
export const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  Effect.sync(() => sorted[Math.ceil((p / 100) * sorted.length) - 1]!)

// Each feed's timed trades, by the minute they arrived in, until that
// minute's line is logged. The trading day's minute flush logs them
// (`armFlush` in trading-day.ts).
export const makeFeedLagLog = Effect.sync(() => {
  const minutes = new Map<number, Map<Feed, Array<number>>>()

  const record = (timed: ReadonlyArray<TimedTrade>) =>
    Effect.sync(() => {
      for (const { feed, arrived, lag } of timed) {
        const minute = arrived - (arrived % MINUTE_MS)
        const feeds = minutes.get(minute) ?? new Map<Feed, Array<number>>()
        minutes.set(minute, feeds)
        const lags = feeds.get(feed) ?? []
        feeds.set(feed, lags)
        lags.push(lag)
      }
    })

  // One line per feed for every minute that ended before now, then forgets
  // them. A feed that timed no trade in a minute gets no line.
  const logEnded = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const ended = [...minutes]
      .filter(([minute]) => minute + MINUTE_MS <= now)
      .sort(([a], [b]) => a - b)
    for (const [minute, feeds] of ended) {
      for (const [feed, lags] of feeds) {
        const sorted = [...lags].sort((a, b) => a - b)
        yield* Effect.logInfo("Feed lag").pipe(
          Effect.annotateLogs({
            feed,
            minute: new Date(minute).toISOString(),
            trades: sorted.length,
            p50Ms: yield* percentile(sorted, 50),
            p99Ms: yield* percentile(sorted, 99),
            maxMs: sorted.at(-1)!,
          })
        )
      }
      minutes.delete(minute)
    }
  })

  // Whether a minute's lines are still to be logged.
  const hasUnlogged = Effect.sync(() => minutes.size > 0)

  return { record, logEnded, hasUnlogged }
})
