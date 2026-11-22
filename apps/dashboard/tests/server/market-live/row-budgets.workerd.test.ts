// The rows each day object operation bills on a busy-sized day, counted by
// workerd's cursors (spec apinrdw/kumora#554, "Testing Decisions"). Each
// budget names an operation in billing/operations.ts. The busy day is built
// once for each `layer` block, so every budget lives here.
import { assert, layer } from "@effect/vitest"
import {
  HEAT_SLICE_MS,
  decodeRecordedBookEvents,
  decodeRecordedHeatmap,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BUSY_DAY, FLUSHED_BOOK_EVENTS } from "../../../billing/busy-figures"
import { CHUNK } from "../../../src/server/market-live/broker-codes"
import { TRADE_CHUNK } from "../../../src/server/market-live/tape-chunks"
import type { OperationName } from "../../../billing/operations"

import { asMoved } from "./moved-answer"
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
// at most 4.2 s (the whole suite about 80 s), so each gets 10 s, or 20 s for
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

    it.effect(
      "today's sealed object, woken in the evening, answers a status pass without restoring the live day",
      () =>
        Effect.gen(function* () {
          const { start, rows, status } = yield* (yield* BusyDay).billed(
            "status pass on its own evening, freshly started"
          )
          assert.strictEqual(status, 200)
          // Restoring the live day at the start read the tape's newest
          // 10,000 trades and the day's candles (apinrdw/kumora#589).
          assert.isAtMost(start.rowsRead, 50)
          assert.isAtMost(rows.rowsRead, 5_000)
          // The day's usage line, its date's first, marks its fact.
          assert.isAtMost(rows.rowsWritten, 1)
        }),
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

    it.effect(
      "a sealed day's object starts without reading its book events, and a code's GET reads that code's alone",
      () =>
        Effect.gen(function* () {
          const { start, rows, status, answer } =
            yield* (yield* BusyDay).billed("book events GET, freshly started")
          assert.strictEqual(status, 200)
          const ofCode = BUSY_DAY.bookEvents / BUSY_DAY.codes
          const { events } = yield* decodeRecordedBookEvents(answer)
          assert.lengthOf(events, ofCode)
          // The start read 10 rows, none a book event (26 with the index
          // drop of the day's first): reading the day's newest, it read
          // 48,010, two an event.
          assert.isAtMost(start.rowsRead, 50)
          // The code's 30 by the key's prefix, and the step that ends them.
          assert.isAtMost(rows.rowsRead, ofCode + 10)
        }),
      10_000
    )

    // An index on the events' time made it two rows an event: 2,000.
    it.effect(
      "a flush writes one row for each book event",
      () =>
        withinBudget("book events flush", { rowsWritten: FLUSHED_BOOK_EVENTS }),
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

// Its second operation drops the day's order flow events, so it runs on a
// busy day of its own.
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a restore",
  (it) => {
    // Coding standards, "Bounded memory on a Worker": the restart's replay
    // reads back the stored order flow events of the codes it found events
    // for, a code at a time, never the whole day's.
    it.effect(
      "a restore reads no stored order flow event of a code whose replay found none",
      () =>
        Effect.gen(function* () {
          const busy = yield* BusyDay
          const stored = yield* busy.billed(
            "restore on its own evening, freshly started"
          )
          const none = yield* busy.billed(
            "restore on its own evening, without order flow events"
          )
          assert.strictEqual(stored.status, 200)
          assert.strictEqual(none.status, 200)
          // Reading the day's 20,000 to drop those stored, it read 40,000
          // rows more: 392,582 against 352,584.
          assert.isAtMost(stored.rows.rowsRead, none.rows.rowsRead + 10)
        }),
      // The two restores take about 3.5 s here, each replaying the day's
      // order flow. They took 24.6 s, past this timeout, while the replay
      // yielded to the scheduler and saved every minute's state (PR #633).
      20_000
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
    // chunks of the minutes the batch's trades fall in. The walking day's
    // object restores the live day first: the test takes 4 s here, and took
    // 14.6 s before the order flow replay was cut (PR #633).
    it.effect(
      "a walk batch that fills 5,000 trades reads at most 10 K rows, its tape summary in place of its tape",
      () => withinBudget("walk batch", { rowsRead: 10_000 }),
      20_000
    )
  }
)

// A move empties the object, so it runs on a busy day of its own. It moves
// to alchemy's local R2 (Miniflare's R2, as `alchemy dev` runs it).
layer(BusyDay.layer, { timeout: "60 seconds", excludeTestServices: true })(
  "row budgets of a move",
  (it) => {
    // Spec apinrdw/kumora#556, "Testing Decisions". Measured on the busy
    // day's chunked tape: 9 alarm runs, 384,945 rows read and 19 written
    // (a progress fact and a wake a run). Its deleteAll() ran no SQL
    // statement, so no cursor counted a row: it dropped 352,672 rows, the
    // database from 84,951,040 bytes to 4,096. The move takes about 13 s
    // here, about 1.5 s a run, so it gets 60 s on CI's 2 cores.
    // Spec apinrdw/kumora#556: for a day moved to a local R2, every
    // recorded-day answer from R2 equals the object's answer, the tape's read
    // by range.
    it.effect(
      "a busy day's move to R2 reads at most 3 M rows and writes at most 50, its deleteAll() bills no row, and R2 answers as the object did",
      () =>
        Effect.gen(function* () {
          const { rows, emptied, tables, checks, values } =
            yield* (yield* BusyDay).moved
          assert.isAtMost(rows.rowsRead, 3_000_000)
          assert.isAtMost(rows.rowsWritten, 50)
          assert.strictEqual(emptied.rowsRead, 0)
          assert.strictEqual(emptied.rowsWritten, 0)
          assert.deepStrictEqual(tables, [])
          // A 404 is sent as Not recorded, whatever the object said: the
          // busy day has no code list, which its object answers in its own
          // words, and the move stores no answer but a 200 (cold-days.ts).
          for (const { resource, hot, cold } of checks)
            if (hot.status === 200)
              assert.deepStrictEqual(
                cold,
                { ...hot, body: asMoved(hot.body) },
                resource
              )
            else assert.strictEqual(cold.status, hot.status, resource)
          assert.deepStrictEqual(
            checks.map(({ resource, hot }) => `${resource} ${hot.status}`),
            [
              "Codes 404",
              "Gaps 200",
              "Tape 200",
              "Tape 200",
              "Tape 200",
              "BrokerCodes 200",
              "BrokerCodes 200",
              "Candles 200",
              "Sweeps 200",
              "SweepBrokers 200",
              "Heatmap 200",
              "Book 200",
              "Book 200",
              "Book 404",
              "BookEvents 200",
            ]
          )
          // The busy day's codes each found book events (PR #588's 30 a
          // code), so this answer comes from the code's own stored object.
          assert.include(checks[14]!.cold.body, '"recorded":true,"events":[{')
          assert.strictEqual(values.hot.status, 200)
          assert.deepStrictEqual(values.cold, values.hot)
          assert.include(checks[2]!.cold.body, '"tradeNumber":"1460000"')
          // Each tape answer reads the index once, kept after, and its
          // blocks by range: at most two.
          for (const { resource, gets } of checks.filter((check) =>
            ["Tape", "BrokerCodes"].includes(check.resource)
          )) {
            const ranged = gets.filter((get) => get.includes("+"))
            assert.isAtLeast(ranged.length, 1, resource)
            assert.isAtMost(ranged.length, 2, resource)
          }
          assert.lengthOf(
            checks.flatMap(({ gets }) =>
              gets.filter((get) => get.endsWith("tape/index.json"))
            ),
            1
          )
        }),
      60_000
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
