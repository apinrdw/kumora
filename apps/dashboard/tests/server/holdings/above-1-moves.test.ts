// Holder moves' Monthly derivation and read over above-1% reports written
// straight into a memory HoldingsDb: a calendar month with two reports.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { Month } from "@/domain/holdings"
import { majorHolders } from "@/lib/major-holders"
import {
  deriveMoveMonth,
  staleMoveMonths,
} from "@/server/holdings/above-1-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"
import { stockPage } from "@/server/holdings/stock-page"

import { seedAbove1AtCap } from "./above-1-at-cap.ts"
import { memoryHoldingsDb } from "./memory-holdings-db.ts"

// Three reports, the last two dated in October. Each renames the stock's 2
// holders, so each report after the first has 2 New and 2 Off list.
const REPORTS = ["2026-09-30", "2026-10-29", "2026-10-30"].map((date) =>
  WibDate.make(date)
)
const CODE = StockCode.make("TWIN")

const seeded = () => {
  const db = memoryHoldingsDb()
  seedAbove1AtCap(db, REPORTS, [CODE], 2)
  return db
}

describe("Holder moves' Monthly, in a month with two above-1% reports", () => {
  it.effect("derives each report's moves, the later one's too", () =>
    Effect.gen(function* () {
      const lines = yield* Effect.forEach(REPORTS, deriveMoveMonth).pipe(
        Effect.provide(seeded().layer)
      )
      assert.deepStrictEqual(lines, [0, 4, 4])
    })
  )

  it.effect(
    "shows the month's later report: its lines, its date and what it is against",
    () =>
      Effect.gen(function* () {
        const read = yield* Effect.gen(function* () {
          for (const report of yield* staleMoveMonths())
            yield* deriveMoveMonth(report)
          return yield* holderMovesRead({
            kind: "monthly",
            month: Month.make("2026-10"),
          })
        }).pipe(Effect.provide(seeded().layer))
        assert.deepInclude(read, {
          period: REPORTS[2],
          against: REPORTS[1],
        })
        assert.lengthOf(read.lines, 4)
      })
  )

  it.effect("links to the report its stock's Major holders shows", () =>
    Effect.gen(function* () {
      const page = yield* stockPage(CODE, undefined).pipe(
        Effect.provide(seeded().layer)
      )
      const held = yield* majorHolders(page.majorHolders, "2026-10")
      assert.strictEqual(held?.dataDate, "2026-10-30")
    })
  )
})
