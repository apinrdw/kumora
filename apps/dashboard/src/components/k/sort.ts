import { Effect } from "effect"

export type KSort<TRow extends object> = {
  key: Extract<keyof TRow, string>
  dir: "asc" | "desc"
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), "id")
}

/** Returns a sorted copy. Missing values sort last in both directions. */
export const sortRows = <TRow extends object>(
  rows: ReadonlyArray<TRow>,
  sort: KSort<TRow>
): Effect.Effect<Array<TRow>> =>
  Effect.sync(() =>
    [...rows].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      if (x == null) return y == null ? 0 : 1
      if (y == null) return -1
      const r = compare(x, y)
      return sort.dir === "asc" ? r : -r
    })
  )
