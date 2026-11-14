// Sweeps (spec apinrdw/kumora#263, "Sweep rule"): one stock code's
// regular-board trades in trade-number order, grouped while they share an
// aggressor side and a second. Another code's trades never break a sweep;
// this code's trade on the other side does, and so does a no-side trade. A
// second sits inside one minute, so a sweep never crosses one. The trading-day
// Durable Object groups each minute's trades into its footprint row, and the
// Market Live page groups the trades after a sweeps GET's answer the same way.
import { DateTime, Effect, Schema } from "effect"

import { StockCode } from "./codes.ts"
import type { RunningTrade } from "./envelope.ts"
import { TradeNumber } from "./envelope.ts"

// One sweep: its aggressor side, its first trade's time, its first and last
// price, and its lots, value and trade count. Side `none` is an auction
// match's prints in one second: no aggressor, so no sweep, but the sweep log
// shows it as one neutral row.
const Sweep = Schema.Struct({
  side: Schema.Literals(["buy", "sell", "none"]),
  time: Schema.DateTimeUtcFromMillis,
  first: Schema.Int,
  last: Schema.Int,
  lots: Schema.Finite,
  value: Schema.Finite,
  trades: Schema.Int,
})
export type Sweep = typeof Sweep.Type

// Appends `next` to `sweeps` in place, each in turn after the last: one that
// shares the last's side and second carries it on, any other starts a sweep.
// A trade is a sweep of one; two sweeps a grouping left side by side never
// share both, so a later grouping's sweeps append the same way.
const extend = (sweeps: Array<Sweep>, next: Iterable<Sweep>) =>
  Effect.sync(() => {
    const secondOf = (time: DateTime.Utc) =>
      Math.floor(DateTime.toEpochMillis(time) / 1000)
    for (const sweep of next) {
      const last = sweeps.at(-1)
      if (
        last === undefined ||
        last.side !== sweep.side ||
        secondOf(last.time) !== secondOf(sweep.time)
      ) {
        sweeps.push(sweep)
        continue
      }
      sweeps[sweeps.length - 1] = {
        side: last.side,
        time: last.time,
        first: last.first,
        last: sweep.last,
        lots: last.lots + sweep.lots,
        value: last.value + sweep.value,
        trades: last.trades + sweep.trades,
      }
    }
  })

// Adds the code's next regular-board trades, ascending by trade number, to
// `sweeps` in place.
export const addToSweeps = (
  sweeps: Array<Sweep>,
  trades: Iterable<RunningTrade>
) =>
  extend(
    sweeps,
    Array.from(trades, (trade): Sweep => ({
      side: trade.side,
      time: trade.time,
      first: trade.price,
      last: trade.price,
      lots: trade.lots,
      value: trade.price * trade.lots * 100,
      trades: 1,
    }))
  )

// One code's regular-board trades, ascending by trade number, as sweeps.
export const sweepsOf = Effect.fnUntraced(function* (
  trades: Iterable<RunningTrade>
) {
  const sweeps: Array<Sweep> = []
  yield* addToSweeps(sweeps, trades)
  return sweeps
})

// The sweeps a GET answered followed by those grouped from the code's trades
// after it: the answer's last sweep and the later first are one when they
// share a side and a second.
export const joinSweeps = Effect.fnUntraced(function* (
  answered: ReadonlyArray<Sweep>,
  later: ReadonlyArray<Sweep>
) {
  const sweeps = [...answered]
  yield* extend(sweeps, later)
  return sweeps
})

// One code's sweeps for the day so far, ascending, and the highest trade
// number they were built up to, of any code: the page groups only trades
// numbered above it. Absent while the day has no trade.
const RecordedSweeps = Schema.Struct({
  code: StockCode,
  through: Schema.optionalKey(TradeNumber),
  sweeps: Schema.Array(Sweep),
})
export type RecordedSweeps = typeof RecordedSweeps.Type

export const encodeRecordedSweeps = Schema.encodeEffect(
  Schema.fromJsonString(RecordedSweeps)
)
export const decodeRecordedSweeps = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedSweeps)
)
