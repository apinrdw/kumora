// Sweeps (spec apinrdw/kumora#263, "Sweep rule"): one stock code's
// regular-board trades in trade-number order, grouped while they share an
// aggressor side and a second. Another code's trades never break a sweep;
// this code's trade on the other side does, and so does a no-side trade. A
// second sits inside one minute, so a sweep never crosses one. Only the
// trading-day Durable Object groups: it keeps each minute's sweeps in its
// footprint row, answers a day's by GET and sends a changed minute's in a
// delta, and the Market Live page shows them as sent.
import { DateTime, Effect, Schema } from "effect"

import { StockCode } from "./codes.ts"
import type { RunningTrade } from "./envelope.ts"
import { SHARES_PER_LOT, Sweep } from "./envelope.ts"

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
        firstTrade: last.firstTrade,
        time: last.time,
        first: last.first,
        last: sweep.last,
        lots: last.lots + sweep.lots,
        value: last.value + sweep.value,
        trades: last.trades + sweep.trades,
      }
    }
  })

// One code's regular-board trades, ascending by trade number, as sweeps.
export const sweepsOf = Effect.fnUntraced(function* (
  trades: Iterable<RunningTrade>
) {
  const sweeps: Array<Sweep> = []
  yield* extend(
    sweeps,
    Array.from(trades, (trade): Sweep => ({
      side: trade.side,
      firstTrade: trade.tradeNumber,
      time: trade.time,
      first: trade.price,
      last: trade.price,
      lots: trade.lots,
      value: trade.price * trade.lots * SHARES_PER_LOT,
      trades: 1,
    }))
  )
  return sweeps
})

// A minute's stored sweeps followed by those grouped from its trades
// numbered after them: the stored last sweep and the later first are one
// when they share a side and a second.
export const joinSweeps = Effect.fnUntraced(function* (
  stored: ReadonlyArray<Sweep>,
  later: ReadonlyArray<Sweep>
) {
  const sweeps = [...stored]
  yield* extend(sweeps, later)
  return sweeps
})

// One code's sweeps for the day so far, ascending.
const RecordedSweeps = Schema.Struct({
  code: StockCode,
  sweeps: Schema.Array(Sweep),
})
export type RecordedSweeps = typeof RecordedSweeps.Type

export const encodeRecordedSweeps = Schema.encodeEffect(
  Schema.fromJsonString(RecordedSweeps)
)
export const decodeRecordedSweeps = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedSweeps)
)
