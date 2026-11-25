// The stock page's Daily holders read at its bound (CODING_STANDARDS.md,
// "Bounded memory on a Worker"): one stock whose every parsed day is at the
// above-5% parse's caps.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { stockPage } from "@/server/holdings/stock-page"

import { retainedHeap } from "../../support/retained-heap.ts"
import { ABOVE_5_DAY_ROWS, datesOf, seedAbove5AtCap } from "./above-5-at-cap.ts"
import { inBoundedHeap } from "./bounded-heap.ts"
import { memoryHoldingsDb, MIGRATIONS } from "./memory-holdings-db.ts"

// Decision: Daily holders reads the stock's newest above-5% days that fit
// a row budget (apps/dashboard/docs/adr/0133-daily-holders-reads-the-newest-days-that-fit-a-row-budget.md)
const HEAP_LIMIT_MIB = 32
// The whole heap of a worker that reads the stock page and runs the Daily
// holders view model over it (daily-holders-worker.ts).
const VIEW_HEAP_MIB = 64

// What the Daily holders of a stock of `days` days show, each day with
// `holders` holders no other day has, of `accounts` accounts each.
const dailyHoldersInBoundedHeap = (
  days: number,
  holders: number,
  accounts: number
) =>
  inBoundedHeap(
    new URL("./daily-holders-worker.ts", import.meta.url),
    { migrations: MIGRATIONS, dates: datesOf(days), holders, accounts },
    VIEW_HEAP_MIB
  )

describe("the stock page's Daily holders read", () => {
  it.effect(
    "keeps the newest day and the one before at the parse's caps, in 32 MiB",
    () =>
      Effect.gen(function* () {
        const db = memoryHoldingsDb()
        const dates = datesOf(4)
        seedAbove5AtCap(db, dates, ["CAPS"], ABOVE_5_DAY_ROWS)
        const before = yield* retainedHeap
        const page = yield* stockPage(StockCode.make("CAPS"), undefined).pipe(
          Effect.provide(db.layer)
        )
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        assert.deepStrictEqual(
          page.dailyHolders.map(({ dataDate, holders }) => [
            dataDate,
            holders.length,
          ]),
          dates.slice(-2).map((date) => [date, ABOVE_5_DAY_ROWS])
        )
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )
})

describe("the stock page's Daily holders read and view model", () => {
  // 26,100 of the budget's 32,002 rows: 181 MiB when each day kept its own
  // list of earlier holders (apinrdw/kumora#673's review).
  it.effect(
    "show 450 days of 19 new holders each in 64 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* dailyHoldersInBoundedHeap(450, 19, 2),
          `450 days: 19 listed, 19 off list, ${448 * 19} earlier`
        )
      }),
    { timeout: 120_000 }
  )
})
