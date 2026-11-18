// The rows each day object operation bills on a busy-sized day, counted by
// workerd's cursors (spec apinrdw/kumora#554, "Testing Decisions"). Each
// budget names an operation in billing/operations.ts. The busy day is built
// once for this file, so every budget lives here.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import type { OperationName } from "../../../billing/operations"

import { BusyDay } from "./workerd"

interface Budget {
  readonly rowsRead?: number
  readonly rowsWritten?: number
}

// `operation`'s own rows, the trading day's start and its `before` left out,
// held to `budget`.
const withinBudget = Effect.fnUntraced(function* (
  operation: OperationName,
  budget: Budget
) {
  const { rows, status } = yield* (yield* BusyDay).billed(operation)
  assert.strictEqual(status, 200)
  if (budget.rowsRead !== undefined)
    assert.isAtMost(rows.rowsRead, budget.rowsRead, `${operation}: rows read`)
  if (budget.rowsWritten !== undefined)
    assert.isAtMost(
      rows.rowsWritten,
      budget.rowsWritten,
      `${operation}: rows written`
    )
})

// Decision: building the busy day takes about 6 s here; on CI's 2 cores the
// build and its bundle get a minute.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets",
  (it) => {
    it.effect(
      "a recorded codes GET reads the tape's 200 trades and their chunk, and writes nothing",
      () =>
        withinBudget("recorded codes GET", { rowsRead: 250, rowsWritten: 0 })
    )

    // Baseline for apinrdw/kumora#559: the status re-counts the whole tape,
    // 1.46 M trades, and steps a window over each page that holds a hole.
    it.effect(
      "baseline: a status pass reads the whole tape, about 2.7 M rows",
      () =>
        Effect.gen(function* () {
          const { rows, status } = yield* (yield* BusyDay).billed("status pass")
          assert.strictEqual(status, 200)
          assert.isAtLeast(rows.rowsRead, 1_460_000)
          assert.isAtMost(rows.rowsRead, 3_000_000)
          assert.strictEqual(rows.rowsWritten, 0)
        }),
      10_000
    )

    // Known over budget until apinrdw/kumora#559, which turns it into `it.effect`.
    it.effect.fails(
      "a status pass reads at most 5 K rows",
      () => withinBudget("status pass", { rowsRead: 5_000 }),
      10_000
    )

    // Known over budget until apinrdw/kumora#560, which turns it into `it.effect`.
    it.effect.fails(
      "a recorded codes GET on a freshly started object reads at most 250 rows",
      () =>
        withinBudget("recorded codes GET, freshly started", { rowsRead: 250 }),
      10_000
    )
  }
)
