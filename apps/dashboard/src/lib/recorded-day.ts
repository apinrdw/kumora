// What a recorded day shows at its replay cursor, worked out in the browser
// from the day's GETs (spec apinrdw/kumora#138, "Recorded day loads").
import type {
  Candle,
  DayState,
  RecordedCandles,
  WibDate,
} from "@workspace/relay"
import { DateTime } from "effect"

const MINUTE = 60_000

// Where a recorded day opens: the end of the close's minute, 16:15 WIB, when
// post-trading ends. Every trade of the day is at or before it.
export const closeOf = (day: WibDate) =>
  DateTime.makeUnsafe(`${day}T16:15:59.999+07:00`)

/**
 * One code's watchlist row at `cursor`, to the minute: last is the close of
 * the cursor's minute (or the latest minute before it that traded), totals
 * sum every candle up to it. Undefined before the code's first candle.
 */
export function dayStateAt(
  answer: RecordedCandles,
  cursor: DateTime.Utc
): DayState | undefined {
  const upTo = answer.candles.filter((candle) =>
    DateTime.isLessThanOrEqualTo(candle.minute, cursor)
  )
  const first = upTo[0]
  const latest = upTo.at(-1)
  if (first === undefined || latest === undefined) return undefined
  // Decision: a code whose day had no `liveprice` frame has no previous
  // close; its change runs from the day's open, so the row still reads.
  const previousClose = answer.previousClose ?? first.open
  const change = latest.close - previousClose
  return {
    code: answer.code,
    last: latest.close,
    previousClose,
    change,
    changePercent: previousClose === 0 ? 0 : (change / previousClose) * 100,
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
}

/**
 * The close the chart header shows before the code has a Day state: the last
 * candle's, or at `cursor` the latest candle's at or before it, so scrubbing
 * before the code's first candle shows no price rather than a later one.
 */
export function lastCloseAt(
  candles: ReadonlyArray<Candle>,
  cursor: DateTime.Utc | undefined
): number | undefined {
  if (cursor === undefined) return candles.at(-1)?.close
  for (let index = candles.length - 1; index >= 0; index--) {
    const candle = candles[index]!
    if (DateTime.isLessThanOrEqualTo(candle.minute, cursor)) return candle.close
  }
  return undefined
}
