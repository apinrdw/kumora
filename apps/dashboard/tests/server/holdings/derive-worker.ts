// A Node worker thread that seeds a memory HoldingsDb with Holder moves'
// worst day at the above-5% parse's caps (holder-moves-heap.test.ts),
// derives that day's lines, and posts their number or the failure's
// message. It runs in plain Node, outside Vitest's aliases, so it resolves
// `@/` to src/ itself (src-alias.ts) and is handed the migrations.
import "./src-alias.ts"

import { parentPort, workerData } from "node:worker_threads"

import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { memoryD1 } from "../memory-d1.ts"
import { renameEveryOtherDay, seedAbove5AtCap } from "./above-5-at-cap.ts"

const { migrations, dates, stocks, blocks } = workerData as {
  readonly migrations: Record<string, string>
  readonly dates: ReadonlyArray<string>
  readonly stocks: ReadonlyArray<string>
  readonly blocks: number
}

const db = memoryD1(migrations)
seedAbove5AtCap(db, dates, stocks, blocks)
renameEveryOtherDay(db, dates)

const { deriveMoveDay } =
  await import("../../../src/server/holdings/above-5-moves.ts")

Effect.runFork(
  deriveMoveDay(WibDate.make(dates.at(-1) ?? "")).pipe(
    Effect.match({
      onSuccess: (lines) => `Derived ${lines} lines`,
      onFailure: (error) => String(error),
    }),
    Effect.tap((message) =>
      Effect.sync(() => parentPort?.postMessage(message))
    ),
    Effect.provideService(HoldingsDb, {
      // The memory D1 keeps every statement it ran; D1 doesn't.
      batch: (statements) =>
        db.batch(statements).pipe(
          Effect.map(({ rows }) => rows),
          Effect.tap(() =>
            Effect.sync(() => {
              db.statements.length = 0
            })
          ),
          Effect.orDie
        ),
    })
  )
)
