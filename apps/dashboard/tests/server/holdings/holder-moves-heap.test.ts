// Holder moves' Daily derivation and read at their bound (CODING_STANDARDS.md,
// "Bounded memory on a Worker"): 21 parsed days at the above-5% parse's caps,
// 50 stocks of 160 blocks a day, renamed every other day so each day has the
// most lines a day can have (renameEveryOtherDay).
import { Worker } from "node:worker_threads"

import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { TREND_PERIODS } from "@/domain/holdings"
import { deriveMoveDay } from "@/server/holdings/above-5-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"

import { retainedHeap } from "../../support/retained-heap.ts"
import {
  ABOVE_5_DAY_ROWS,
  datesOf,
  renameEveryOtherDay,
  seedAbove5AtCap,
} from "./above-5-at-cap.ts"
import { memoryHoldingsDb, MIGRATIONS } from "./memory-holdings-db.ts"

// Decision: Holder moves are derived at parse time
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
//
// The worker's whole heap: about 25 MiB is its own (its modules and the
// seeded memory D1), and deriving takes the rest. It fit 64 MiB, not 56, on
// 25 Nov 2026.
const DERIVE_HEAP_MIB = 72
const READ_HEAP_MIB = 32

const DATES = datesOf(TREND_PERIODS + 1)
const STOCKS = Array.from(
  { length: 50 },
  (_, at) => `S${String(at).padStart(3, "0")}`
)
const BLOCKS = ABOVE_5_DAY_ROWS / STOCKS.length
const LINES = 2 * ABOVE_5_DAY_ROWS

// What deriving the newest day posts (derive-worker.ts), derived in a worker
// thread whose heap stops at DERIVE_HEAP_MIB. A derivation past it fails
// with the worker's out-of-memory error.
const deriveInBoundedHeap = Effect.callback<string, Error>((resume) => {
  const worker = new Worker(new URL("./derive-worker.ts", import.meta.url), {
    workerData: {
      migrations: MIGRATIONS,
      dates: DATES,
      stocks: STOCKS,
      blocks: BLOCKS,
    },
    resourceLimits: { maxOldGenerationSizeMb: DERIVE_HEAP_MIB },
  })
  worker.once("message", (message: string) => resume(Effect.succeed(message)))
  worker.once("error", (error) => resume(Effect.fail(error)))
  return Effect.promise(() => worker.terminate())
})

describe("Holder moves' Daily derivation and read", () => {
  it.effect(
    "derive a day at the parse's caps in 72 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* deriveInBoundedHeap, `Derived ${LINES} lines`)
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
        if (read.kind !== "daily") return assert.fail(read.kind)
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
