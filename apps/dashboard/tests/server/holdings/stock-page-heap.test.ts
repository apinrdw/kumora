// The stock page's Daily holders and Major holders at their bound
// (CODING_STANDARDS.md, "Bounded memory on a Worker"): one stock whose
// parsed periods fill its row budget (holders-window.ts).
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { ROWS_SHOWN } from "@/components/k/bounded-rows"
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
import { bundled, inBoundedHeap } from "./bounded-heap.ts"
import { memoryHoldingsDb, MIGRATIONS } from "./memory-holdings-db.ts"
import type { StockPageSeed } from "./stock-page-worker.tsx"

// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const HEAP_LIMIT_MIB = 32
// Two months at the above-1% parse's caps hold almost twice two days' rows,
// each with more text: 31.6 MiB on 25 Nov 2026.
const MONTHS_HEAP_LIMIT_MIB = 48
// The whole heap of a worker that reads the stock page and renders its Daily
// holders and Major holders panels, as the page's server render does
// (stock-page-worker.tsx): about 30 MiB is its own, React with it, and the
// read, the panels' view models and their render take the rest. Every case
// fit 88 MiB on 25 Nov 2026 and the tightest not 84; a worker thread's limit
// isn't exact, so the bound leaves room.
const PAGE_HEAP_MIB = 96

// The table rows a panel renders of a list longer than BoundedRows shows:
// its header, the rows shown and the row that shows more.
const TABLE_ROWS = 1 + ROWS_SHOWN + 1

interface Seeded {
  // Each day's holders, of `accounts` securities accounts each; `churn`
  // gives every day holders no other day has.
  readonly days?: StockPageSeed["days"]
  // Each month's holders; `churn` gives every month holders no other has.
  readonly months?: StockPageSeed["months"]
}

// What the stock page of a stock seeded so shows (stock-page-worker.tsx):
// the periods read, each panel's summary and the table rows rendered.
const pageInBoundedHeap = ({ days, months }: Seeded) =>
  Effect.flatMap(
    bundled(new URL("./stock-page-worker.tsx", import.meta.url)),
    (worker) =>
      inBoundedHeap(
        worker,
        {
          migrations: MIGRATIONS,
          days: days ?? { dates: [], holders: 0, accounts: 1, churn: false },
          months: months ?? { dates: [], holders: 0, churn: false },
        } satisfies StockPageSeed,
        PAGE_HEAP_MIB
      )
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

// The budget's 32,002 rows as the most a panel can make of them. Every
// day's holders are new, so each is a line of the newest day: listed, off
// the list, or an earlier holder. The table renders its first rows of them
// (BoundedRows): rendered whole, two days at the cap took over 128 MiB in
// the render alone (apinrdw/kumora#673's review).
describe("the stock page's Daily holders read and render", () => {
  // 26,100 rows: 181 MiB when each day kept its own list of earlier holders
  // (apinrdw/kumora#673's review).
  it.effect(
    "show 450 days of 19 new holders each in 96 MiB of heap",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* pageInBoundedHeap({
            days: {
              dates: datesOf(450),
              holders: 19,
              accounts: 2,
              churn: true,
            },
          }),
          `450 days of 19, 0 months of 0; daily 19 holders hold: 19 new, 0 up, 0 down, 19 off list, ${448 * 19} earlier; major none; ${TABLE_ROWS} rows`
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
          yield* pageInBoundedHeap({
            days: {
              dates: datesOf(days),
              holders: 1,
              accounts: 1,
              churn: true,
            },
          }),
          `${days} days of 1, 0 months of 0; daily 1 holder holds: 1 new, 0 up, 0 down, 1 off list, ${days - 2} earlier; major none; ${TABLE_ROWS} rows`
        )
      }),
    { timeout: 120_000 }
  )

  // The most lines: 10 s on 25 Nov 2026, in the rename test of each new
  // holder against each gone one.
  it.effect(
    "show two days at the parse's caps, every holder new",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* pageInBoundedHeap({
            days: {
              dates: datesOf(2),
              holders: ABOVE_5_DAY_ROWS,
              accounts: 1,
              churn: true,
            },
          }),
          `2 days of ${ABOVE_5_DAY_ROWS}, 0 months of 0; daily ${ABOVE_5_DAY_ROWS} holders hold: ${ABOVE_5_DAY_ROWS} new, 0 up, 0 down, ${ABOVE_5_DAY_ROWS} off list, 0 earlier; major none; ${TABLE_ROWS} rows`
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

// A stock's months as the most Major holders can make of them. The panel
// renders a tab and an Every month column for each month read, and the
// grid a cell for each holder in each: the window reads at most its
// `periods` of months, and the grid renders its first rows.
describe("the stock page's Major holders read and render", () => {
  const { periods = 0 } = MONTHLY_WINDOW

  // 29,760 rows: every month's holders are new, so each is a row of the
  // table and of the grid, 240 cells wide.
  it.effect(
    "show the most months read, each of 124 new holders, in 96 MiB of heap",
    () =>
      Effect.gen(function* () {
        const holders = Math.floor(MONTHLY_WINDOW.budget / periods) - 1
        assert.strictEqual(
          yield* pageInBoundedHeap({
            months: { dates: monthsOf(periods), holders, churn: true },
          }),
          `0 days of 0, ${periods} months of ${holders}; daily none, 0 earlier; major ${holders} holders hold: ${holders} new, 0 up, 0 down, ${holders} off list; ${TABLE_ROWS + 1 + 25 + 1} rows`
        )
      }),
    { timeout: 120_000 }
  )

  // The budget alone reads 15,001 months of one holder, whose tabs and
  // columns took over 88 MiB to render.
  it.effect(
    "read the newest 240 of a stock's months",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* pageInBoundedHeap({
            months: { dates: monthsOf(periods + 60), holders: 1, churn: true },
          }),
          `0 days of 0, ${periods} months of 1; daily none, 0 earlier; major 1 holder holds: 1 new, 0 up, 0 down, 1 off list; ${TABLE_ROWS + 1 + 25 + 1} rows`
        )
      }),
    { timeout: 120_000 }
  )
})

// A stock whose every day has `blocks` blocks of one securities account and
// whose every month has `holders` holders, each month's renamed from the
// month before's.
const both = (days: number, blocks: number, months: number, holders: number) =>
  pageInBoundedHeap({
    days: { dates: datesOf(days), holders: blocks, accounts: 1, churn: false },
    months: { dates: monthsOf(months), holders, churn: false },
  })

describe("the stock page's read and render of both Daily holders and Major holders", () => {
  const MONTHS_AT_CAP = `major ${ABOVE_1_MONTH_ROWS} holders hold: ${ABOVE_1_MONTH_ROWS} new, 0 up, 0 down, ${ABOVE_1_MONTH_ROWS} off list`

  // 62,004 rows read together took 144 MiB of heap, more than a Worker has
  // (apinrdw/kumora#673's review). The months leave no day at the cap room.
  it.effect(
    "fits 96 MiB of heap for a stock at both parses' caps",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* both(3, ABOVE_5_DAY_ROWS, 3, ABOVE_1_MONTH_ROWS),
          `0 days of 0, 2 months of ${ABOVE_1_MONTH_ROWS}; daily none, 0 earlier; ${MONTHS_AT_CAP}; ${2 * TABLE_ROWS} rows`
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
          yield* both(3, blocks, 3, ABOVE_1_MONTH_ROWS),
          `2 days of ${blocks}, 2 months of ${ABOVE_1_MONTH_ROWS}; daily ${blocks} holders hold: 0 new, ${blocks} up, 0 down, 0 off list, 0 earlier; ${MONTHS_AT_CAP}; ${3 * TABLE_ROWS} rows`
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
          yield* both(3, ABOVE_5_DAY_ROWS, 2, holders),
          `2 days of ${ABOVE_5_DAY_ROWS}, 2 months of ${holders}; daily ${ABOVE_5_DAY_ROWS} holders hold: 0 new, ${ABOVE_5_DAY_ROWS} up, 0 down, 0 off list, 0 earlier; major ${holders} holders hold: ${holders} new, 0 up, 0 down, ${holders} off list; ${3 * TABLE_ROWS} rows`
        )
      }),
    { timeout: 120_000 }
  )
})
