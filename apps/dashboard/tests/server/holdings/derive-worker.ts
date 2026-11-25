// A Node worker thread that seeds a memory HoldingsDb with Holder moves'
// worst period of a kind at its parse's caps (holder-moves-heap.test.ts):
// a day at the above-5% parse's, or a month at the above-1% parse's. It
// derives that period's lines, and posts their number or the failure's
// message. It runs in plain Node, outside Vitest's aliases, so it resolves
// `@/` to src/ itself (src-alias.ts) and is handed the migrations.
import "./src-alias.ts"

import { parentPort, workerData } from "node:worker_threads"

import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { memoryD1 } from "../memory-d1.ts"
import { seedAbove1AtCap } from "./above-1-at-cap.ts"
import { renameEveryOtherDay, seedAbove5AtCap } from "./above-5-at-cap.ts"

const { kind, migrations, dates, stocks, holders } = workerData as {
  readonly kind: "daily" | "monthly"
  readonly migrations: Record<string, string>
  readonly dates: ReadonlyArray<string>
  readonly stocks: ReadonlyArray<string>
  // A stock's blocks a day, or holders a month.
  readonly holders: number
}

const db = memoryD1(migrations)
if (kind === "daily") {
  seedAbove5AtCap(db, dates, stocks, holders)
  renameEveryOtherDay(db, dates)
} else seedAbove1AtCap(db, dates, stocks, holders)

const derive =
  kind === "daily"
    ? (await import("../../../src/server/holdings/above-5-moves.ts"))
        .deriveMoveDay
    : (await import("../../../src/server/holdings/above-1-moves.ts"))
        .deriveMoveMonth

Effect.runFork(
  derive(WibDate.make(dates.at(-1) ?? "")).pipe(
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
