// The stock page's Daily holders and Major holders at their bound
// (CODING_STANDARDS.md, "Bounded memory on a Worker"): one stock whose
// parsed periods fill its row budget (holders-window.ts).
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import {
  DAILY_WINDOW,
  MONTHLY_WINDOW,
  PAGE_BUDGET,
} from "@/server/holdings/holders-window"
import { stockPage } from "@/server/holdings/stock-page"

import { retainedHeap } from "../../support/retained-heap.ts"
import {
  ABOVE_1_MONTH_ROWS,
  monthsOf,
  seedAbove1AtCap,
} from "./above-1-at-cap.ts"
import { ABOVE_5_DAY_ROWS, datesOf, seedAbove5AtCap } from "./above-5-at-cap.ts"
import { inBoundedHeap } from "./bounded-heap.ts"
import { memoryHoldingsDb, MIGRATIONS } from "./memory-holdings-db.ts"

// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const HEAP_LIMIT_MIB = 32
// Two months at the above-1% parse's caps hold almost twice two days' rows,
// each with more text: 31.6 MiB on 25 Nov 2026.
const MONTHS_HEAP_LIMIT_MIB = 48
// The whole heap of a worker that reads the stock page and runs the Daily
// holders view model over it (daily-holders-worker.ts): about 25 MiB is its
// own, and the read and the view model take the rest. The two days at the
// caps fit 80 MiB, not 72, on 25 Nov 2026, and the other two 64, not 56.
const VIEW_HEAP_MIB = 88
// The whole heap of a worker that reads the stock page of a stock with both
// kinds of holders (stock-page-worker.ts), about 25 MiB of it its own.
const PAGE_HEAP_MIB = 88

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

// The budget's 32,002 rows as the most a view model can make of them. Every
// day's holders are new, so each is a line of the newest day: listed, off
// the list, or an earlier holder.
describe("the stock page's Daily holders read and view model", () => {
  // 26,100 rows: 181 MiB when each day kept its own list of earlier holders
  // (apinrdw/kumora#673's review).
  it.effect(
    "show 450 days of 19 new holders each in 88 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* dailyHoldersInBoundedHeap(450, 19, 2),
          `450 days: 19 listed, 19 off list, ${448 * 19} earlier`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "show the most days of holders the budget reads, a new holder a day",
    () =>
      Effect.gen(function* () {
        const days = Math.floor(DAILY_WINDOW.budget / 3)
        assert.strictEqual(
          yield* dailyHoldersInBoundedHeap(days, 1, 1),
          `${days} days: 1 listed, 1 off list, ${days - 2} earlier`
        )
      }),
    { timeout: 120_000 }
  )

  // The most lines: 40 s on 25 Nov 2026, in the rename test of each new
  // holder against each gone one.
  it.effect(
    "show two days at the parse's caps, every holder new",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* dailyHoldersInBoundedHeap(2, ABOVE_5_DAY_ROWS, 1),
          `2 days: ${ABOVE_5_DAY_ROWS} listed, ${ABOVE_5_DAY_ROWS} off list, 0 earlier`
        )
      }),
    { timeout: 300_000 }
  )
})

describe("the stock page's Major holders read", () => {
  it.effect(
    "keeps the newest month and the one before at the parse's caps, in 48 MiB",
    () =>
      Effect.gen(function* () {
        const db = memoryHoldingsDb()
        const months = monthsOf(4)
        seedAbove1AtCap(db, months, ["CAPS"], ABOVE_1_MONTH_ROWS)
        const before = yield* retainedHeap
        const page = yield* stockPage(StockCode.make("CAPS"), undefined).pipe(
          Effect.provide(db.layer)
        )
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        assert.deepStrictEqual(
          page.majorHolders.map(({ dataDate, holders }) => [
            dataDate,
            holders.length,
          ]),
          months.slice(-2).map((date) => [date, ABOVE_1_MONTH_ROWS])
        )
        assert.isBelow(
          retained,
          MONTHS_HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )
})

// Each kind's periods the stock page reads, as their holders' numbers, of a
// stock whose every day has `blocks` blocks of one securities account and
// whose every month has `holders` holders.
const pageInBoundedHeap = (
  days: number,
  blocks: number,
  months: number,
  holders: number
) =>
  inBoundedHeap(
    new URL("./stock-page-worker.ts", import.meta.url),
    {
      migrations: MIGRATIONS,
      days: datesOf(days),
      blocks,
      months: monthsOf(months),
      holders,
    },
    PAGE_HEAP_MIB
  )

describe("the stock page's read of both Daily holders and Major holders", () => {
  // 62,004 rows read together took 144 MiB of heap, more than a Worker has
  // (apinrdw/kumora#673's review). The months leave no day at the cap room.
  it.effect(
    "fits 88 MiB of heap for a stock at both parses' caps",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* pageInBoundedHeap(3, ABOVE_5_DAY_ROWS, 3, ABOVE_1_MONTH_ROWS),
          `days [], months [${ABOVE_1_MONTH_ROWS},${ABOVE_1_MONTH_ROWS}]`
        )
      }),
    { timeout: 120_000 }
  )

  // The page's whole budget, in its heaviest rows: the months' 30,002 and
  // 5,998 of days.
  it.effect(
    "fits it with two months at the cap and the days that fit beside them",
    () =>
      Effect.gen(function* () {
        const blocks = Math.floor(
          ((PAGE_BUDGET - MONTHLY_WINDOW.budget) / 2 - 1) / 2
        )
        assert.strictEqual(
          yield* pageInBoundedHeap(3, blocks, 3, ABOVE_1_MONTH_ROWS),
          `days [${blocks},${blocks}], months [${ABOVE_1_MONTH_ROWS},${ABOVE_1_MONTH_ROWS}]`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "keeps a day at the cap and the one before beside 4,000 rows of months",
    () =>
      Effect.gen(function* () {
        const holders = (PAGE_BUDGET - DAILY_WINDOW.budget) / 2 - 1
        assert.strictEqual(
          yield* pageInBoundedHeap(3, ABOVE_5_DAY_ROWS, 2, holders),
          `days [${ABOVE_5_DAY_ROWS},${ABOVE_5_DAY_ROWS}], months [${holders},${holders}]`
        )
      }),
    { timeout: 120_000 }
  )
})
