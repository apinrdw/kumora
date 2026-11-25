// Holder moves' derivation and read at their bound (CODING_STANDARDS.md,
// "Bounded memory on a Worker"), for each kind: 21 parsed days at the
// above-5% parse's caps, 50 stocks of 160 blocks a day, renamed every other
// day so each day has the most lines a day can have (renameEveryOtherDay);
// and 21 parsed months at the above-1% parse's caps, 50 stocks of 300
// holders a month, renamed every other month (seedAbove1AtCap).
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { Month, TREND_PERIODS } from "@/domain/holdings"
import { deriveMoveMonth } from "@/server/holdings/above-1-moves"
import { deriveMoveDay } from "@/server/holdings/above-5-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"

import { retainedHeap } from "../../support/retained-heap.ts"
import {
  ABOVE_1_MONTH_ROWS,
  monthsOf,
  seedAbove1AtCap,
} from "./above-1-at-cap.ts"
import {
  ABOVE_5_DAY_ROWS,
  datesOf,
  renameEveryOtherDay,
  seedAbove5AtCap,
} from "./above-5-at-cap.ts"
import { inBoundedHeap } from "./bounded-heap.ts"
import { memoryHoldingsDb, MIGRATIONS } from "./memory-holdings-db.ts"

// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
//
// The worker's whole heap: about 25 MiB is its own (its modules and the
// seeded memory D1), and deriving takes the rest. A day fit 64 MiB, not 56,
// and a month 72, not 64, on 25 Nov 2026.
const DERIVE_HEAP_MIB = 72
const READ_HEAP_MIB = 32
// A month at the caps has twice a day's lines; it read in 39.5 MiB on 25 Nov
// 2026.
const MONTH_READ_HEAP_MIB = 48

const DATES = datesOf(TREND_PERIODS + 1)
const STOCKS = Array.from(
  { length: 50 },
  (_, at) => `S${String(at).padStart(3, "0")}`
)
const BLOCKS = ABOVE_5_DAY_ROWS / STOCKS.length
const LINES = 2 * ABOVE_5_DAY_ROWS

const MONTHS = monthsOf(TREND_PERIODS + 1)
const HOLDERS = ABOVE_1_MONTH_ROWS / STOCKS.length
const MONTH_LINES = 2 * ABOVE_1_MONTH_ROWS

// What deriving a kind's newest period posts (derive-worker.ts), derived in
// a worker thread whose heap stops at DERIVE_HEAP_MIB.
const deriveInBoundedHeap = (
  kind: "daily" | "monthly",
  dates: ReadonlyArray<string>,
  holders: number
) =>
  inBoundedHeap(
    new URL("./derive-worker.ts", import.meta.url),
    { kind, migrations: MIGRATIONS, dates, stocks: STOCKS, holders },
    DERIVE_HEAP_MIB
  )

describe("Holder moves' Daily derivation and read", () => {
  it.effect(
    "derive a day at the parse's caps in 72 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* deriveInBoundedHeap("daily", DATES, BLOCKS),
          `Derived ${LINES} lines`
        )
      }),
    { timeout: 300_000 }
  )

  it.effect(
    "read a day at the parse's caps in 32 MiB",
    () =>
      Effect.gen(function* () {
        const db = memoryHoldingsDb()
        seedAbove5AtCap(db, DATES, STOCKS, BLOCKS)
        renameEveryOtherDay(db, DATES)
        const day = WibDate.make(DATES.at(-1) ?? "")
        yield* deriveMoveDay(day).pipe(Effect.provide(db.layer))
        db.statements.length = 0
        const before = yield* retainedHeap
        const read = yield* holderMovesRead({ kind: "daily", day }).pipe(
          Effect.provide(db.layer)
        )
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        assert.strictEqual(read.lines.length, LINES)
        assert.isBelow(
          retained,
          READ_HEAP_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 300_000 }
  )
})

describe("Holder moves' Monthly derivation and read", () => {
  it.effect(
    "derive a month at the parse's caps in 72 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* deriveInBoundedHeap("monthly", MONTHS, HOLDERS),
          `Derived ${MONTH_LINES} lines`
        )
      }),
    { timeout: 300_000 }
  )

  it.effect(
    "read a month at the parse's caps in 48 MiB",
    () =>
      Effect.gen(function* () {
        const db = memoryHoldingsDb()
        seedAbove1AtCap(db, MONTHS, STOCKS, HOLDERS)
        const month = WibDate.make(MONTHS.at(-1) ?? "")
        yield* deriveMoveMonth(month).pipe(Effect.provide(db.layer))
        db.statements.length = 0
        const before = yield* retainedHeap
        const read = yield* holderMovesRead({
          kind: "monthly",
          month: Month.make(month.slice(0, 7)),
        }).pipe(Effect.provide(db.layer))
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        assert.strictEqual(read.lines.length, MONTH_LINES)
        assert.isBelow(
          retained,
          MONTH_READ_HEAP_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 300_000 }
  )
})
