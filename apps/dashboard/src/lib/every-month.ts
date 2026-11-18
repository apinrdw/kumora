// The Major holders panel's Every month grid (spec apinrdw/kumora#479,
// "Major holders panel"; apinrdw/kumora#474's amendment): each holder of
// any month of the stock, its summed % in every month, sorted by the month
// selected in the panel's tabs.
import { Effect } from "effect"

import { largestRow } from "@/lib/major-holders"
import type {
  MajorHolder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

// Against the month before, as the table's chips decide it: by the change
// in summed percentage, or new when the holder wasn't listed. None in the
// stock's first month or after a month the stock has no rows in.
type Move = "up" | "down" | "new"

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

// `selected` is the panel's month's data date. Rows listed in it come
// first, by its %; the rest follow by their newest %.
export const everyMonth = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  selected: string
) {
  const byKey = months.map(
    ({ holders }) => new Map(holders.map((each) => [each.key, each]))
  )
  const newest = new Map<string, MajorHolder>()
  for (const holders of byKey)
    for (const [key, each] of holders) newest.set(key, each)
  const current =
    byKey[months.findIndex(({ dataDate }) => dataDate === selected)]

  const cellOf = (key: string, index: number): Cell | undefined => {
    const now = byKey[index]?.get(key)
    if (now === undefined) return undefined
    const before = byKey[index - 1]
    const previous = before?.get(key)
    const hundredths = now.percentageHundredths
    return {
      hundredths,
      move:
        before === undefined || before.size === 0
          ? undefined
          : previous === undefined
            ? "new"
            : hundredths > previous.percentageHundredths
              ? "up"
              : hundredths < previous.percentageHundredths
                ? "down"
                : undefined,
    }
  }

  const rows = yield* Effect.forEach(
    newest.values(),
    Effect.fnUntraced(function* (latest) {
      const shown = current?.get(latest.key) ?? latest
      return {
        row: {
          key: latest.key,
          name: (yield* largestRow(shown)).name,
          listed: current?.has(latest.key) ?? false,
          cells: months.map((_, index) => cellOf(latest.key, index)),
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
    // The largest % of any holder in any month, which shades the darkest.
    largest: Math.max(
      0,
      ...months.flatMap(({ holders }) =>
        holders.map(({ percentageHundredths }) => percentageHundredths)
      )
    ),
  }
})
