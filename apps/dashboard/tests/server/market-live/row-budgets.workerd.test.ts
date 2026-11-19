// The rows each day object operation bills on a busy-sized day, counted by
// workerd's cursors (spec apinrdw/kumora#554, "Testing Decisions"). Each
// budget names an operation in billing/operations.ts. The busy day is built
// once for each `layer` block, so every budget lives here.
import { assert, layer } from "@effect/vitest"
import { HEAT_SLICE_MS, decodeRecordedHeatmap } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BUSY_DAY } from "../../../billing/busy-figures"
import { CHUNK } from "../../../src/server/market-live/broker-codes"
import { TRADE_CHUNK } from "../../../src/server/market-live/tape-chunks"
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
// build and its bundle get a minute, as does its teardown. A test here takes
// at most 2.6 s (the whole suite about 45 s), so each gets 10 s, or 20 s for
// one over 2 s: CI's 2 cores run it about twice as slow.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets",
  (it) => {
    it.effect(
      "a recorded codes GET reads the tape's 200 trades and their chunk, and writes nothing",
      () =>
        withinBudget("recorded codes GET", { rowsRead: 250, rowsWritten: 0 }),
      10_000
    )

    // Spec apinrdw/kumora#555: a page reads its trades' chunks and the number
    // search's, never a row per trade.
    it.effect(
      "a recorded tape GET at the day's end reads at most 50 rows, and writes nothing",
      () => withinBudget("recorded tape GET", { rowsRead: 50, rowsWritten: 0 }),
      10_000
    )

    it.effect(
      "a recorded tape page below a midday trade reads at most 50 rows, and writes nothing",
      () =>
        withinBudget("recorded tape page", { rowsRead: 50, rowsWritten: 0 }),
      10_000
    )

    it.effect(
      "a status pass on a sealed relay day reads at most 5 K rows, its tape summary in place of the tape",
      () => withinBudget("status pass", { rowsRead: 5_000, rowsWritten: 0 }),
      10_000
    )

    // Decision: a codes GET reads its 200 tape trades on any object, so the
    // spec's 10 rows bound what a fresh object reads past a warm one: the
    // codes-complete fact, never a status pass (#560).
    it.effect(
      "a recorded codes GET on a freshly started object reads at most 10 rows more than on one that ran a status pass",
      () =>
        Effect.gen(function* () {
          const busy = yield* BusyDay
          const warm = yield* busy.billed("recorded codes GET")
          const fresh = yield* busy.billed(
            "recorded codes GET, freshly started"
          )
          assert.strictEqual(fresh.status, 200)
          assert.deepStrictEqual(fresh.answer, warm.answer)
          assert.isAtMost(fresh.rows.rowsRead, warm.rows.rowsRead + 10)
          assert.strictEqual(fresh.rows.rowsWritten, 0)
        }),
      10_000
    )

    it.effect(
      "a heatmap GET reads its code's book chunks, at most 300 rows, and writes nothing",
      () =>
        Effect.gen(function* () {
          const heatmap = yield* decodeRecordedHeatmap(
            (yield* (yield* BusyDay).billed("heatmap GET")).answer
          )
          // A slice every 10 s from the first chunk, 09:00, to the day's
          // end, the frameless minutes filled in.
          const from = DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
          )
          assert.lengthOf(
            heatmap.slices,
            (DateTime.toEpochMillis(heatmap.through) - from) / HEAT_SLICE_MS
          )
          yield* withinBudget("heatmap GET", { rowsRead: 300, rowsWritten: 0 })
        }),
      10_000
    )
  }
)

// Its first GET writes the codes-complete fact, so it runs on a busy day of
// its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a day batched before the codes-complete fact",
  (it) => {
    it.effect(
      "its first codes GET reads its chunks once and writes the fact, and the next reads at most 10 rows more than a warm object",
      () =>
        Effect.gen(function* () {
          const busy = yield* BusyDay
          const first = yield* busy.billed(
            "recorded codes GET, batched before the codes-complete fact"
          )
          const next = yield* busy.billed("recorded codes GET, freshly started")
          const warm = yield* busy.billed("recorded codes GET")
          assert.strictEqual(first.status, 200)
          assert.deepStrictEqual(first.answer, warm.answer)
          const chunks = Math.ceil(BUSY_DAY.trades / CHUNK)
          // One read of its chunks past a warm GET: 1,686 rows read against
          // 225. Writing the fact billed 2 rows written.
          assert.isAtMost(first.rows.rowsRead, warm.rows.rowsRead + chunks + 10)
          assert.isAtMost(first.rows.rowsWritten, 2)
          assert.isAtMost(next.rows.rowsRead, warm.rows.rowsRead + 10)
          assert.strictEqual(next.rows.rowsWritten, 0)
        }),
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

// A correcting batch writes too, so it runs on a busy day of its own. The day
// is recorded with the broker trades index, 2.92 M rows, as every day before
// apinrdw/kumora#561 is. The batch can run once: sent again, it changes no
// codes.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a correcting batch",
  (it) => {
    it.effect(
      "a woken object drops the index for a few rows, and a batch writes no index row",
      () =>
        Effect.gen(function* () {
          const { start, rows, status, tables } =
            yield* (yield* BusyDay).billed("correcting batch")
          assert.strictEqual(status, 200)
          assert.notInclude(tables, "broker_trades")
          // The drop bills its schema reads, not a row per indexed side: 14
          // rows read, none written. The one row written deletes the
          // rebuild's fact.
          assert.isAtMost(start.rowsRead, 50)
          assert.isAtMost(start.rowsWritten, 1)
          // Its chunks and its trades' sweep brokers rows, about 2.4 K. With
          // the index it wrote 21.4 K: two side rows a changed trade.
          assert.isAtMost(rows.rowsWritten, 3_000)
          // Spec apinrdw/kumora#555: sweep brokers' recompute reads its
          // minutes' trade chunks, not their trades.
          assert.isAtMost(rows.rowsRead, 10_000)
        }),
      10_000
    )
  }
)

// Its first pass writes the summary, so it runs on a busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a day sealed before the tape summary",
  (it) => {
    it.effect(
      "its first status pass reads the trade chunks once, and the next reads at most 5 K rows",
      () =>
        Effect.gen(function* () {
          const { before, rows, status } = yield* (yield* BusyDay).billed(
            "status pass after the summary's build"
          )
          const chunks = Math.ceil(BUSY_DAY.trades / TRADE_CHUNK)
          assert.strictEqual(status, 200)
          assert.isAtLeast(before.rowsRead, chunks)
          assert.isAtMost(before.rowsRead, 5_000 + 1.1 * chunks)
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
    // Spec apinrdw/kumora#555: sweep brokers' recompute reads the trade
    // chunks of the minutes the batch's trades fall in.
    it.effect(
      "a walk batch that fills 5,000 trades reads at most 10 K rows, its tape summary in place of its tape",
      () => withinBudget("walk batch", { rowsRead: 10_000 }),
      20_000
    )
  }
)

// A flush writes trades, so it runs on a busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a live flush",
  (it) => {
    it.effect(
      "a flush of a busy minute and its late trades writes at most 20 rows, its trade chunks",
      () => withinBudget("live flush", { rowsWritten: 20 }),
      10_000
    )
  }
)

// A session's end writes its books over the last one's, so it runs on a busy
// day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a session's end",
  (it) => {
    it.effect(
      "a session's end writes at most a row per code with a book, over the last session's",
      () => withinBudget("session end", { rowsWritten: BUSY_DAY.codes }),
      10_000
    )
  }
)
