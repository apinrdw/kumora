// A footprint row's sweeps (spec apinrdw/kumora#263, "The trading-day Durable
// Object"): one stock code's sweeps in one minute, grouped from its trades by
// the rule in @workspace/relay's sweeps.ts. The day store writes them in the
// footprint row beside the cells (day-store.ts).
import type { Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

// The wire tuple's order (@workspace/relay envelope.ts `Sweep`); change both.
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

// Decision: footprint cells and sweeps are tuples, not keyed objects
// (packages/relay/docs/adr/0007-footprint-cells-and-sweeps-are-tuples-on-the-wire-and-in-storage.md)
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
