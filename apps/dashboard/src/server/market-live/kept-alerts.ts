// The day's sweep alerts while a trade of theirs is on the tape (spec
// apinrdw/kumora#510, "Snapshot"), so a viewer's snapshot marks the same rows
// a delta marked. The page never plays a snapshot's alerts.
import type { RunningTrade, SweepAlert } from "@workspace/relay"
import { TradeNumberOrder } from "@workspace/relay"
import { Effect } from "effect"

// Decision: the alerts live only in the object's memory, not in its store: a
// restarted object snapshots none until it decides new ones, and an open
// page keeps the marks it had across the reconnect (lib/tape.ts,
// `applyViewerMessage`). See apinrdw/kumora#513.
export const makeKeptAlerts = Effect.sync(() => {
  let kept: Array<SweepAlert> = []

  // A delta's alerts kept, and those whose trades all left `tape`, ascending
  // by trade number, dropped: a trade below its oldest never returns to it.
  const keep = (
    alerts: ReadonlyArray<SweepAlert>,
    tape: ReadonlyArray<RunningTrade>
  ) =>
    Effect.sync(() => {
      const oldest = tape[0]?.tradeNumber
      kept = [...kept, ...alerts].filter(
        (alert) =>
          oldest === undefined ||
          alert.tradeNumbers.some(
            (number) => TradeNumberOrder(number, oldest) >= 0
          )
      )
    })

  // The alerts with a trade on `tape`.
  const on = (tape: ReadonlyArray<RunningTrade>) =>
    Effect.sync(() => {
      const held = new Set(tape.map((trade) => trade.tradeNumber))
      return kept.filter((alert) =>
        alert.tradeNumbers.some((number) => held.has(number))
      )
    })

  return { keep, on }
})
