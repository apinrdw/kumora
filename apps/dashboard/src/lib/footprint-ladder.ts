// Chart 2's hover ladder (spec apinrdw/kumora#263, "Hover ladder"): the
// hovered minute's exact figures, readable at any zoom.
import { Effect } from "effect"

import type { FootprintColumn } from "./footprint"
import {
  direction,
  lots,
  price,
  signed,
  tapeTime,
  type Direction,
} from "./format"

// One price of the ladder, exact, and whether the pointer is on it.
export interface LadderRow {
  readonly price: string
  readonly sell: string
  readonly buy: string
  // No-side lots as `+n`, empty when none.
  readonly none: string
  readonly here: boolean
}

export interface Ladder {
  readonly title: string
  // Highest price first, as the chart stacks them.
  readonly rows: ReadonlyArray<LadderRow>
  // Vol, Δ and CVD: label, exact figure and its tone.
  readonly totals: ReadonlyArray<readonly [string, string, Direction]>
}

// The ladder of `column` with the pointer at `pointer`: the row nearest it
// is highlighted.
export const footprintLadder = Effect.fnUntraced(function* (
  column: FootprintColumn,
  pointer: number
) {
  let nearest: number | undefined
  for (const row of column.rows)
    if (
      nearest === undefined ||
      Math.abs(row.price - pointer) < Math.abs(nearest - pointer)
    )
      nearest = row.price
  const rows: Array<LadderRow> = []
  for (const row of [...column.rows].reverse())
    rows.push({
      price: yield* price(row.price),
      sell: yield* lots(row.sell),
      buy: yield* lots(row.buy),
      none: row.none === 0 ? "" : `+${yield* lots(row.none)}`,
      here: row.price === nearest,
    })
  const { volume, delta, cvd } = column.totals
  return {
    title: `${(yield* tapeTime(column.minute)).slice(0, 5)} WIB · Sell × Buy`,
    rows,
    totals: [
      ["Vol", yield* lots(volume), "flat"],
      ["Δ", yield* signed(delta), yield* direction(delta)],
      ["CVD", yield* signed(cvd), yield* direction(cvd)],
    ],
  } satisfies Ladder
})
