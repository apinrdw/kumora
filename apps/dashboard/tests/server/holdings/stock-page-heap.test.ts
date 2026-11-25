// The stock page's Daily holders read at its bound (CODING_STANDARDS.md,
// "Bounded memory on a Worker"): one stock whose every parsed day is at the
// above-5% parse's caps.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { stockPage } from "@/server/holdings/stock-page"

import { retainedHeap } from "../../support/retained-heap.ts"
import { ABOVE_5_DAY_ROWS, datesOf, seedAbove5AtCap } from "./above-5-at-cap.ts"
import { memoryHoldingsDb } from "./memory-holdings-db.ts"

// Decision: Daily holders reads the stock's newest above-5% days that fit
// a row budget (apps/dashboard/docs/adr/0133-daily-holders-reads-the-newest-days-that-fit-a-row-budget.md)
const HEAP_LIMIT_MIB = 32

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
