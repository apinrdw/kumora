// What a day's tape offers (tape.ts), which both of its backings implement:
// a row per trade (tape.ts) and 1,000-number trade chunks (tape-chunks.ts).
import {
  MINUTE_MS,
  type RunningTrade,
  type StockCode,
  type TapeCursor,
  type TradeNumber,
} from "@workspace/relay"
import { type DateTime, Effect } from "effect"

// The most a stored trade's time can run before the time of the trade
// numbered before it: Ajaib's and the backfill's rounding to the second.
export const TIME_SKEW_MS = 1_000

// A held trade's fields the broker codes store reads (broker-codes.ts).
export interface TapeFields {
  readonly number: number
  readonly code: StockCode
  readonly price: number
  readonly lots: number
  readonly board: RunningTrade["board"]
}

// The first and last minute that can hold a stored trade.
interface MinuteSpan {
  readonly first: number
  readonly last: number
}

// Decision: `write`, `highestNumber`, `numbersBetween` and
// `rebuildCandleSides` are plain, as the `Sql` port's methods are: the day
// store's flush and the broker codes store's batches and summaries call them
// inside a synchronous transaction, where an Effect could not run. The other
// methods are Effects.
export interface Tape {
  // Which backing holds the day's trades (tape.ts, `makeTape`).
  readonly shape: "rows" | "chunks"
  // The trades, inside a transaction. A number is written once.
  readonly write: (trades: ReadonlyArray<RunningTrade>) => void
  readonly highestNumber: () => number | undefined
  // The numbers held from `low` to `high`, ascending.
  readonly numbersBetween: (low: number, high: number) => Array<number>
  // Each stored candle's buy and sell value from the stored trades.
  readonly rebuildCandleSides: () => void
  readonly has: (tradeNumber: TradeNumber) => Effect.Effect<boolean>
  // How many trades the day stored so far.
  readonly count: Effect.Effect<number>
  // The newest `limit` trades, ascending.
  readonly newest: (limit: number) => Effect.Effect<Array<RunningTrade>>
  // The newest `limit` trades at or before `at`, below `before` when it is
  // given, ascending.
  readonly tradesAt: (
    cursor: TapeCursor,
    limit: number
  ) => Effect.Effect<Array<RunningTrade>>
  // The trades after `after` and at or before `through`, ascending.
  readonly tradesBetween: (
    after: DateTime.Utc,
    through: DateTime.Utc
  ) => Effect.Effect<Array<RunningTrade>>
  // The first and last minute that can hold a stored trade, widened by
  // TIME_SKEW_MS; none when the day stored none.
  readonly minuteSpan: Effect.Effect<MinuteSpan | undefined>
  // The minutes the stored trades numbered `first` to `last` fall in,
  // ascending; none when it holds none of them.
  readonly minutesOf: (
    first: TradeNumber,
    last: TradeNumber
  ) => Effect.Effect<Array<number>>
  // The numbers from `low` to `high` the tape lacks, marked 1 in `marks`
  // from `low`.
  readonly markLacking: (
    low: number,
    high: number,
    marks: Uint8Array
  ) => Effect.Effect<void>
  // The fields of the trades held from `low` to `high`, ascending.
  readonly fieldsBetween: (
    low: number,
    high: number
  ) => Effect.Effect<Array<TapeFields>>
}

// The minute `time` falls in.
export const minuteFloor = (time: number) =>
  Effect.sync(() => Math.floor(time / MINUTE_MS) * MINUTE_MS)

// The minutes from `earliest`'s to `latest`'s, ascending; none when
// `earliest` is after `latest`.
export const minutesSpanning = Effect.fnUntraced(function* (
  earliest: number,
  latest: number
) {
  const minutes: Array<number> = []
  for (
    let minute = yield* minuteFloor(earliest);
    minute <= latest;
    minute += MINUTE_MS
  )
    minutes.push(minute)
  return minutes
})
