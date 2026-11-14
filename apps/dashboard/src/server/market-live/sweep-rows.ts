// A footprint row's sweeps (spec apinrdw/kumora#263, "The trading-day Durable
// Object"): one stock code's sweeps in one minute, grouped from its trades by
// the rule in @workspace/relay's sweeps.ts. The day store writes them in the
// footprint row beside the cells (day-store.ts).
import type { Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

type SweepTuple = readonly [
  side: Sweep["side"],
  firstTrade: Sweep["firstTrade"],
  time: number,
  first: number,
  last: number,
  lots: number,
  value: number,
  trades: number,
]

// Decision: a footprint row stores its sweeps as one JSON text of
// [side, first trade, time, first, last, lots, value, trades] tuples in trade
// order, like its cells (footprint-cells.ts): a busy code has 10–18 K sweeps
// a day, a few hundred a minute, and the row is replaced whole. See spec
// apinrdw/kumora#263.
export const sweepsText = (sweeps: ReadonlyArray<Sweep>) =>
  Effect.sync(() =>
    JSON.stringify(
      sweeps.map((sweep): SweepTuple => [
        sweep.side,
        sweep.firstTrade,
        DateTime.toEpochMillis(sweep.time),
        sweep.first,
        sweep.last,
        sweep.lots,
        sweep.value,
        sweep.trades,
      ])
    )
  )

// Rows are the store's own writes, so they are read back without a decode.
export const sweepsFromText = (text: string) =>
  Effect.sync((): ReadonlyArray<Sweep> =>
    (JSON.parse(text) as ReadonlyArray<SweepTuple>).map(
      ([side, firstTrade, time, first, last, lots, value, trades]) => ({
        side,
        firstTrade,
        time: DateTime.makeUnsafe(time),
        first,
        last,
        lots,
        value,
        trades,
      })
    )
  )
