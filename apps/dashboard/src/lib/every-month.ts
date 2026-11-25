// The Major holders panel's Every month grid (spec apinrdw/kumora#479,
// "Major holders panel"; apinrdw/kumora#474's amendment): each holder of
// any month of the stock, its summed % in every month, sorted by the month
// selected in the panel's tabs.
import { Effect } from "effect"

import type { HolderId } from "@/lib/holder-identity"
import { largestRow, monthMoves } from "@/lib/major-holders"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// Against the month before, by the table's movement rule (monthMoves): up or
// down, or a return when new to the month but listed in an earlier one. A
// holder new for the first time, or unchanged, has none.
type Move = "up" | "down" | "return"

interface Cell {
  readonly hundredths: number
  readonly shares: number
  readonly move: Move | undefined
}

interface GridRow {
  readonly holder: HolderId
  // Its largest row's in the selected month, else in its newest month.
  readonly name: string
  // Listed in the selected month.
  readonly listed: boolean
}

// `selected` is the panel's month's data date. Rows listed in it come
// first, by its %; the rest follow by their newest %. `cellsOf` gives a
// row's cells, one per month and undefined where the holder isn't listed,
// when the row is rendered: every row's cells at once are holders times
// months, which a stock's budget of rows doesn't bound.
export const everyMonth = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  selected: string
) {
  const moves = yield* monthMoves(months)
  const cells = moves.map(
    ({ listed }) =>
      new Map(
        listed.map(({ holder, now, move, returning }): [HolderId, Cell] => [
          holder,
          {
            hundredths: now.percentageHundredths,
            shares: now.total,
            move:
              move === "up" || move === "down"
                ? move
                : move === "new" && returning
                  ? "return"
                  : undefined,
          },
        ])
      )
  )
  const newest = new Map<HolderId, Above1Holder>()
  for (const { listed } of moves)
    for (const { holder, now } of listed) newest.set(holder, now)
  const current =
    cells[months.findIndex(({ dataDate }) => dataDate === selected)]
  const shown = new Map(
    moves
      .find(({ period }) => period === selected)
      ?.listed.map(({ holder, now }) => [holder, now])
  )

  const rows = yield* Effect.forEach(
    newest,
    Effect.fnUntraced(function* ([holder, latest]) {
      const now = shown.get(holder) ?? latest
      return {
        row: {
          holder,
          name: (yield* largestRow(now)).name,
          listed: current?.has(holder) ?? false,
        } satisfies GridRow,
        hundredths: now.percentageHundredths,
      }
    })
  )
  rows.sort(
    (a, b) =>
      Number(b.row.listed) - Number(a.row.listed) || b.hundredths - a.hundredths
  )
  return {
    rows: rows.map(({ row }) => row),
    cellsOf: (holder: HolderId) =>
      Effect.sync(() => cells.map((month) => month.get(holder))),
    // The largest % of any holder in any month, which shades the darkest; at
    // least 1, so a grid of 0% cells shades them all the lightest.
    largest: months.reduce(
      (most, { holders }) =>
        holders.reduce(
          (highest, { percentageHundredths }) =>
            Math.max(highest, percentageHundredths),
          most
        ),
      1
    ),
  }
})
