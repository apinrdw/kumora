import { describe, expect, test } from "vitest"

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
  test("sorts numbers numerically, not as strings", () => {
    expect(tickers(sortRows(rows, { key: "conf", dir: "desc" }))).toEqual([
      "BBCA",
      "BBRI",
      "TLKM",
      "ASII",
    ])
  })

  test("keeps missing values last when ascending", () => {
    expect(tickers(sortRows(rows, { key: "conf", dir: "asc" }))).toEqual([
      "TLKM",
      "BBRI",
      "BBCA",
      "ASII",
    ])
  })

  test("sorts text alphabetically", () => {
    expect(tickers(sortRows(rows, { key: "ticker", dir: "asc" }))).toEqual([
      "ASII",
      "BBCA",
      "BBRI",
      "TLKM",
    ])
  })

  test("does not mutate the input", () => {
    const input = [...rows]
    sortRows(input, { key: "ticker", dir: "asc" })
    expect(tickers(input)).toEqual(["BBRI", "ASII", "BBCA", "TLKM"])
  })
})
