// What a recorded day shows at its replay cursor, worked out in the browser
// from the day's GETs (spec apinrdw/kumora#138, "Recorded day loads").
import type {
  Candle,
  DayState,
  RecordedCandles,
  WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

const MINUTE = 60_000

// Where a recorded day opens: the end of the close's minute, 16:15 WIB, when
// post-trading ends. Every regular-board trade of the day is at or before
// it; the negotiated board's run on until the relay stops at 16:35
// (`replayDay`'s end).
export const closeOf = (day: WibDate) =>
  Effect.sync(() => DateTime.makeUnsafe(`${day}T16:15:59.999+07:00`))

/**
 * One code's watchlist row at `cursor`, to the minute: last is the close of
 * the cursor's minute (or the latest minute before it that traded), totals
 * sum every candle up to it. Undefined before the code's first candle.
 */
export const dayStateAt = Effect.fnUntraced(function* (
  answer: RecordedCandles,
  cursor: DateTime.Utc
): Effect.fn.Return<DayState | undefined> {
  const upTo = answer.candles.filter((candle) =>
    DateTime.isLessThanOrEqualTo(candle.minute, cursor)
  )
  const first = upTo[0]
  const latest = upTo.at(-1)
  if (first === undefined || latest === undefined) return undefined
  // Decision: a code whose day had no `liveprice` frame with a previous
  // close (an index's never carry one) has no change: the row shows none
  // rather than one run from the day's open.
  const previousClose = answer.previousClose
  const amount =
    previousClose === undefined ? undefined : latest.close - previousClose
  return {
    code: answer.code,
    last: latest.close,
    ...(previousClose === undefined || amount === undefined
      ? {}
      : {
          previousClose,
          change: {
            amount,
            percent: previousClose === 0 ? 0 : (amount / previousClose) * 100,
          },
        }),
    open: first.open,
    high: Math.max(...upTo.map((candle) => candle.high)),
    low: Math.min(...upTo.map((candle) => candle.low)),
    volume: upTo.reduce((sum, candle) => sum + candle.volume, 0),
    value: upTo.reduce((sum, candle) => sum + candle.value, 0),
    frequency: upTo.reduce((sum, candle) => sum + candle.frequency, 0),
    asOf: DateTime.makeUnsafe(DateTime.toEpochMillis(latest.minute) + MINUTE),
    // The candles are built from the merged tape, with Stockbit's fields.
    provenance: "Stockbit",
  }
})

/**
 * The close the chart header shows before the code has a Day state: the last
 * candle's, or at `cursor` the latest candle's at or before it, so scrubbing
 * before the code's first candle shows no price rather than a later one.
 */
export const lastCloseAt = (
  candles: ReadonlyArray<Candle>,
  cursor: DateTime.Utc | undefined
): Effect.Effect<number | undefined> =>
  Effect.sync(() => {
    if (cursor === undefined) return candles.at(-1)?.close
    for (let index = candles.length - 1; index >= 0; index--) {
      const candle = candles[index]!
      if (DateTime.isLessThanOrEqualTo(candle.minute, cursor))
        return candle.close
    }
    return undefined
  })
