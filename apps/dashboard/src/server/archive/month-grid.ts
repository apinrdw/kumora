// The year × month layout of an archive admin page's month grids
// (components/admin/archive/month-grid.tsx): the KSEI Coverage card's
// (../ksei/coverage.ts) and the Parse coverage card's
// (../holdings/parse-coverage.ts).
import { Effect } from "effect"

// One row per year from `firstYear` to `last`'s, each with `cell` of its
// months from January, as YYYY-MM, through `last`, a month (YYYY-MM).
export const monthGrid = Effect.fnUntraced(function* <A, E, R>(
  firstYear: number,
  last: string,
  cell: (month: string) => Effect.Effect<A, E, R>
) {
  const lastYear = Number(last.slice(0, 4))
  const lastMonth = Number(last.slice(5, 7))
  return yield* Effect.forEach(
    Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i),
    (year) =>
      Effect.map(
        Effect.forEach(
          Array.from(
            { length: year === lastYear ? lastMonth : 12 },
            (_, m) => `${year}-${String(m + 1).padStart(2, "0")}`
          ),
          cell
        ),
        (months) => ({ year, months })
      )
  )
})
