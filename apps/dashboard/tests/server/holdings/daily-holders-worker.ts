// A Node worker thread that seeds a memory HoldingsDb with one stock's
// above-5% days, each with holders no other day has (seedAbove5Churn), reads
// its stock page and runs the Daily holders view model over the days read,
// as the page's server render does (stock-page-heap.test.ts). It posts the
// newest day's lines by section, or the failure's message. It runs in plain
// Node, outside Vitest's aliases, so it resolves `@/` to src/ itself
// (src-alias.ts) and is handed the migrations.
import "./src-alias.ts"

import { parentPort, workerData } from "node:worker_threads"

import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { memoryD1 } from "../memory-d1.ts"
import { seedAbove5Churn } from "./above-5-at-cap.ts"
import { workerHoldingsDb } from "./worker-holdings-db.ts"

const { migrations, dates, holders, accounts } = workerData as {
  readonly migrations: Record<string, string>
  readonly dates: ReadonlyArray<string>
  // A day's holders, and each one's securities accounts.
  readonly holders: number
  readonly accounts: number
}

const db = memoryD1(migrations)
seedAbove5Churn(db, dates, "CHRN", holders, accounts)

const { stockPage } = await import("../../../src/server/holdings/stock-page.ts")
const { dailyHolders } = await import("../../../src/lib/daily-holders.ts")

Effect.runFork(
  Effect.gen(function* () {
    const page = yield* stockPage(StockCode.make("CHRN"), undefined)
    const held = yield* dailyHolders(page.dailyHolders, undefined)
    return `${page.dailyHolders.length} days: ${held?.listed.length} listed, ${held?.offList.length} off list, ${held?.history.length} earlier`
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
    Effect.tap((message) =>
      Effect.sync(() => parentPort?.postMessage(message))
    ),
    Effect.provideService(HoldingsDb, workerHoldingsDb(db))
  )
)
