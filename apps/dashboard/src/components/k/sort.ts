import { Effect } from "effect"

export type KSort<TRow extends object> = {
  key: Extract<keyof TRow, string>
  dir: "asc" | "desc"
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
      // Array.sort calls this comparator back, so it compares in place.
      const r =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "id")
      return sort.dir === "asc" ? r : -r
    })
  )
