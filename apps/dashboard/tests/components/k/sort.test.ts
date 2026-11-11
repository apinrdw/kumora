import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { sortRows } from "@/components/k/sort"

type Row = { ticker: string; conf: number | null }

const rows: ReadonlyArray<Row> = [
  { ticker: "BBRI", conf: 60 },
  { ticker: "ASII", conf: null },
  { ticker: "BBCA", conf: 82 },
  { ticker: "TLKM", conf: 9 },
]

const tickers = (r: ReadonlyArray<Row>) => r.map((x) => x.ticker)

describe("sortRows", () => {
  it.effect("sorts numbers numerically, not as strings", () =>
    Effect.gen(function* () {
      expect(
        tickers(yield* sortRows(rows, { key: "conf", dir: "desc" }))
      ).toEqual(["BBCA", "BBRI", "TLKM", "ASII"])
    })
  )

  it.effect("keeps missing values last when ascending", () =>
    Effect.gen(function* () {
      expect(
        tickers(yield* sortRows(rows, { key: "conf", dir: "asc" }))
      ).toEqual(["TLKM", "BBRI", "BBCA", "ASII"])
    })
  )

  it.effect("sorts text alphabetically", () =>
    Effect.gen(function* () {
      expect(
        tickers(yield* sortRows(rows, { key: "ticker", dir: "asc" }))
      ).toEqual(["ASII", "BBCA", "BBRI", "TLKM"])
    })
  )

  it.effect("does not mutate the input", () =>
    Effect.gen(function* () {
      const input = [...rows]
      yield* sortRows(input, { key: "ticker", dir: "asc" })
      expect(tickers(input)).toEqual(["BBRI", "ASII", "BBCA", "TLKM"])
    })
  )
})
