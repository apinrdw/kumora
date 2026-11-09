import type { RelayGap, RunningTrade } from "@workspace/relay"
import { DateTime, Effect } from "effect"

// One row of the tape: a trade, or a relay gap's "not recorded" row.
type TapeRow =
  | { readonly kind: "trade"; readonly trade: RunningTrade }
  | { readonly kind: "gap"; readonly gap: RelayGap }

// The tape, newest first, with each relay gap as one row where it fell: above
// the newest trade from before it. A gap older than every trade shown sits at
// the bottom.
export const withGapRows = Effect.fnUntraced(function* (
  trades: ReadonlyArray<RunningTrade>,
  gaps: ReadonlyArray<RelayGap>
) {
  const newestFirst = [...gaps].sort((a, b) => DateTime.Order(b.from, a.from))
  const rows: Array<TapeRow> = []
  let next = 0
  for (const trade of trades) {
    while (
      next < newestFirst.length &&
      DateTime.Order(trade.time, newestFirst[next]!.from) < 0
    )
      rows.push({ kind: "gap", gap: newestFirst[next++]! })
    rows.push({ kind: "trade", trade })
  }
  for (const gap of newestFirst.slice(next)) rows.push({ kind: "gap", gap })
  return rows
})
