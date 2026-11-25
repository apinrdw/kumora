// A Node worker thread that seeds a memory HoldingsDb with one stock whose
// above-5% days and above-1% months are both at their parses' caps
// (above-5-at-cap.ts, above-1-at-cap.ts) and reads its stock page
// (stock-page-heap.test.ts). It posts each kind's periods read as their
// holders' numbers, or the failure's message. It runs in plain Node, outside
// Vitest's aliases, so it resolves `@/` to src/ itself (src-alias.ts) and is
// handed the migrations.
import "./src-alias.ts"

import { parentPort, workerData } from "node:worker_threads"

import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { memoryD1 } from "../memory-d1.ts"
import { seedAbove1AtCap } from "./above-1-at-cap.ts"
import { seedAbove5AtCap } from "./above-5-at-cap.ts"
import { workerHoldingsDb } from "./worker-holdings-db.ts"

const { migrations, days, blocks, months, holders } = workerData as {
  readonly migrations: Record<string, string>
  readonly days: ReadonlyArray<string>
  // A day's blocks, each of one securities account.
  readonly blocks: number
  readonly months: ReadonlyArray<string>
  // A month's holders, a row each.
  readonly holders: number
}

const db = memoryD1(migrations)
seedAbove5AtCap(db, days, ["CAPS"], blocks)
seedAbove1AtCap(db, months, ["CAPS"], holders)

const { stockPage } = await import("../../../src/server/holdings/stock-page.ts")

// Each period's holders, oldest first.
const sizes = (periods: ReadonlyArray<{ holders: ReadonlyArray<unknown> }>) =>
  JSON.stringify(periods.map((period) => period.holders.length))

Effect.runFork(
  stockPage(StockCode.make("CAPS"), undefined).pipe(
    Effect.map(
      (page) =>
        `days ${sizes(page.dailyHolders)}, months ${sizes(page.majorHolders)}`
    ),
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
    Effect.tap((message) =>
      Effect.sync(() => parentPort?.postMessage(message))
    ),
    Effect.provideService(HoldingsDb, workerHoldingsDb(db))
  )
)
