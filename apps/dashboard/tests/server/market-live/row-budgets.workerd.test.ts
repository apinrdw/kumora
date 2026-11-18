// The rows each day object operation bills on a busy-sized day, counted by
// workerd's cursors (spec apinrdw/kumora#554, "Testing Decisions"). Each
// budget names an operation in billing/operations.ts. The busy day is built
// once for this file, so every budget lives here.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { BUSY_DAY } from "../../../billing/busy-figures"
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

    it.effect(
      "a status pass on a sealed relay day reads at most 5 K rows, its tape summary in place of the tape",
      () => withinBudget("status pass", { rowsRead: 5_000, rowsWritten: 0 }),
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

// A batch writes its chunks, so its budget runs on a busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a batch",
  (it) => {
    it.effect(
      "a batch with its buildable and completed checks reads at most 10 K rows",
      () => withinBudget("resent batch", { rowsRead: 10_000 }),
      10_000
    )
  }
)

// Its first pass writes the summary, so it runs on a busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a day sealed before the tape summary",
  (it) => {
    it.effect(
      "its first status pass scans the tape once, and the next reads at most 5 K rows",
      () =>
        Effect.gen(function* () {
          const { before, rows, status } = yield* (yield* BusyDay).billed(
            "status pass after the summary's build"
          )
          assert.strictEqual(status, 200)
          assert.isAtLeast(before.rowsRead, BUSY_DAY.trades)
          assert.isAtMost(before.rowsRead, 1.1 * BUSY_DAY.trades)
          assert.isAtMost(rows.rowsRead, 5_000)
          assert.strictEqual(rows.rowsWritten, 0)
        }),
      20_000
    )
  }
)

// A walk batch fills the tape, so it runs on a busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a walk day's batch",
  (it) => {
    // Decision: over the batch budget of 10 K. Of its 21.4 K rows read, sweep
    // brokers' recompute reads 13.4 K (the minutes the batch's trades fall
    // in, sweep-brokers.ts), the tape takes 5 K and its summary a few.
    it.effect(
      "a walk batch that fills 5,000 trades reads at most 25 K rows, its tape summary in place of its tape",
      () => withinBudget("walk batch", { rowsRead: 25_000 }),
      20_000
    )
  }
)
