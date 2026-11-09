import type { RelayGap } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { TapeRow } from "@/lib/tape"

// A relay gap's "not recorded" row in the tape.
type GapRow = { readonly kind: "gap"; readonly gap: RelayGap }

// The tape's rows in view, newest first, with each relay gap as one row where
// it fell: above the newest trade from before it. A gap newer than the first
// row shows only at the top of the tape, and one older than the last row only
// at its bottom, so a gap outside the rows in view isn't drawn in them.
// Fold rows carry no time and never place a gap.
export const withGapRows = Effect.fnUntraced(function* (
  rows: ReadonlyArray<TapeRow>,
  gaps: ReadonlyArray<RelayGap>,
  edges: { readonly top: boolean; readonly bottom: boolean }
) {
  const newestFirst = [...gaps].sort((a, b) => DateTime.Order(b.from, a.from))
  const out: Array<TapeRow | GapRow> = []
  let next = 0
  let placedAny = false
  for (const row of rows) {
    if (row.kind === "trade") {
      while (
        next < newestFirst.length &&
        DateTime.Order(row.trade.time, newestFirst[next]!.from) < 0
      ) {
        const gap = newestFirst[next++]!
        if (placedAny || edges.top) out.push({ kind: "gap", gap })
      }
      placedAny = true
    }
    out.push(row)
  }
  if (edges.bottom)
    for (const gap of newestFirst.slice(next)) out.push({ kind: "gap", gap })
  return out
})
