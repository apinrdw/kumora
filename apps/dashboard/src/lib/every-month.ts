// The Major holders panel's Every month grid (spec apinrdw/kumora#479,
// "Major holders panel"; apinrdw/kumora#474's amendment): each holder of
// any month of the stock, its summed % in every month, sorted by the month
// selected in the panel's tabs.
import { Effect } from "effect"

import { beforeOf, changeOf, largestRow } from "@/lib/major-holders"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// Against the month before, by the table's movement rule (changeOf): up or
// down, or a return when new to the month but listed in an earlier one. A
// holder new for the first time, or unchanged, has none.
type Move = "up" | "down" | "return"

interface Cell {
  readonly hundredths: number
  readonly move: Move | undefined
}

interface GridRow {
  readonly key: string
  // Its largest row's in the selected month, else in its newest month.
  readonly name: string
  // Listed in the selected month.
  readonly listed: boolean
  // One per month, undefined where the holder isn't listed.
  readonly cells: ReadonlyArray<Cell | undefined>
}

// Each month's cells by holder key.
const cellsByMonth = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>
) {
  const seen = new Set<string>()
  return yield* Effect.forEach(
    months,
    Effect.fnUntraced(function* ({ holders }, index) {
      const { before } = yield* beforeOf(months, index)
      const cells = new Map<string, Cell>()
      for (const holder of holders) {
        const change = yield* changeOf(holder, before)
        cells.set(holder.key, {
          hundredths: holder.percentageHundredths,
          move:
            change === "up" || change === "down"
              ? change
              : change === "new" && seen.has(holder.key)
                ? "return"
                : undefined,
        })
      }
      for (const { key } of holders) seen.add(key)
      return cells
    })
  )
})

// `selected` is the panel's month's data date. Rows listed in it come
// first, by its %; the rest follow by their newest %.
export const everyMonth = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  selected: string
) {
  const byKey = months.map(
    ({ holders }) => new Map(holders.map((each) => [each.key, each]))
  )
  const newest = new Map<string, Above1Holder>()
  for (const holders of byKey)
    for (const [key, each] of holders) newest.set(key, each)
  const current =
    byKey[months.findIndex(({ dataDate }) => dataDate === selected)]
  const cells = yield* cellsByMonth(months)

  const rows = yield* Effect.forEach(
    newest.values(),
    Effect.fnUntraced(function* (latest) {
      const shown = current?.get(latest.key) ?? latest
      return {
        row: {
          key: latest.key,
          name: (yield* largestRow(shown)).name,
          listed: current?.has(latest.key) ?? false,
          cells: cells.map((month) => month.get(latest.key)),
        } satisfies GridRow,
        hundredths: shown.percentageHundredths,
      }
    })
  )
  rows.sort(
    (a, b) =>
      Number(b.row.listed) - Number(a.row.listed) || b.hundredths - a.hundredths
  )
  return {
    rows: rows.map(({ row }) => row),
    // The largest % of any holder in any month, which shades the darkest; at
    // least 1, so a grid of 0% cells shades them all the lightest.
    largest: Math.max(
      1,
      ...months.flatMap(({ holders }) =>
        holders.map(({ percentageHundredths }) => percentageHundredths)
      )
    ),
  }
})
