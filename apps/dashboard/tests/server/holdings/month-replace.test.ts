import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseClassificationMonth } from "@/server/holdings/classification"

import { memoryHoldingsDb } from "./memory-holdings-db.ts"
import { SPLIT_HEADER_ROW, SPLIT_LABELS, workbook } from "./workbook.ts"

// D1's largest statement, its SQL and bound values together.
const D1_STATEMENT_BYTES = 100_000

// The longest issuer name a report may give, of a character JSON writes
// as six: \u0001.
const LONGEST_NAME = "&#1;".repeat(256)

const bytes = (value: string | number | null) =>
  typeof value === "string" ? new TextEncoder().encode(value).length : 0

describe("a month's replace", () => {
  it.effect(
    "keeps every statement within D1's size for the most stocks under the longest issuer names",
    () =>
      Effect.gen(function* () {
        const holdings = memoryHoldingsDb()
        yield* parseClassificationMonth(
          "2026-10-30",
          "sha",
          yield* workbook(
            SPLIT_HEADER_ROW +
              Array.from({ length: 2_000 }, (_, index) => {
                const row = index + 2
                return `<row r="${row}"><c r="B${row}" t="str"><v>S${row}</v></c><c r="C${row}" t="s"><v>${SPLIT_LABELS.length}</v></c></row>`
              }).join(""),
            [...SPLIT_LABELS, LONGEST_NAME]
          ),
          "2026-11-15T00:00:00Z"
        ).pipe(Effect.provide(holdings.layer))
        assert.isAtMost(
          Math.max(
            ...holdings.statements.map(
              ({ sql, params }) =>
                bytes(sql) +
                params.reduce<number>((sum, value) => sum + bytes(value), 0)
            )
          ),
          D1_STATEMENT_BYTES
        )
        assert.deepStrictEqual(
          holdings.database
            .prepare(
              "SELECT count(*) AS stocks, min(issuer_name) = max(issuer_name) AS same, length(min(issuer_name)) AS length FROM classification_stock_month"
            )
            .get(),
          { stocks: 2_000, same: 1, length: 256 }
        )
      })
  )
})
