// A Node worker thread that seeds a memory HoldingsDb with one stock's
// above-5% days and above-1% months (above-5-at-cap.ts, above-1-at-cap.ts),
// reads its stock page and renders its Daily holders and Major holders
// panels as the page's server render does (stock-page-heap.test.ts). It
// posts the periods read, what each panel's summary says and the table rows
// rendered, or the failure's message. Vite bundles it (`bundled` in
// bounded-heap.ts), so it is handed the migrations.
import { parentPort, workerData } from "node:worker_threads"

import { StockCode } from "@workspace/relay"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { Effect } from "effect"

import { DailyHolders } from "@/components/stocks/daily-holders"
import { MajorHolders } from "@/components/stocks/major-holders"
import { HoldingsDb } from "@/server/holdings/db"
import { stockPage } from "@/server/holdings/stock-page"

import { memoryD1 } from "../memory-d1.ts"
import { seedAbove1AtCap, seedAbove1Churn } from "./above-1-at-cap.ts"
import { seedAbove5AtCap, seedAbove5Churn } from "./above-5-at-cap.ts"
import { serverRender } from "./server-render.ts"
import { workerHoldingsDb } from "./worker-holdings-db.ts"

export interface StockPageSeed {
  readonly migrations: Record<string, string>
  // Each day's holders, of `accounts` securities accounts each; `churn`
  // gives every day holders no other day has.
  readonly days: {
    readonly dates: ReadonlyArray<string>
    readonly holders: number
    readonly accounts: number
    readonly churn: boolean
  }
  // Each month's holders, a row each; `churn` gives every month holders no
  // other month has.
  readonly months: {
    readonly dates: ReadonlyArray<string>
    readonly holders: number
    readonly churn: boolean
  }
}

const { migrations, days, months } = workerData as StockPageSeed
const CODE = StockCode.make("CAPS")

const db = memoryD1(migrations)
if (days.churn)
  seedAbove5Churn(db, days.dates, CODE, days.holders, days.accounts)
else seedAbove5AtCap(db, days.dates, [CODE], days.holders)
if (months.churn) seedAbove1Churn(db, months.dates, CODE, months.holders)
else seedAbove1AtCap(db, months.dates, [CODE], months.holders)

// The periods read and the newest one's holders.
const read = (
  periods: ReadonlyArray<{ holders: ReadonlyArray<unknown> }>,
  unit: string
) => `${periods.length} ${unit} of ${periods.at(-1)?.holders.length ?? 0}`

Effect.runFork(
  Effect.gen(function* () {
    const page = yield* stockPage(CODE, undefined)
    const { rows, found } = yield* serverRender(
      <TooltipProvider>
        <DailyHolders
          code={CODE}
          days={page.dailyHolders}
          day={undefined}
          onDay={() => {}}
        />
        <MajorHolders
          code={CODE}
          months={page.majorHolders}
          month={undefined}
          onMonth={() => {}}
        />
      </TooltipProvider>,
      {
        daily:
          /id="daily-holders"[^>]*>[^<]*<\/h2><p[^>]*>(\d+ holders? holds?)[^<]*?: ([^<]*)</,
        earlier: /Earlier holders · (?:<!-- -->)?(\d+)/,
        major:
          /id="major-holders"[^>]*>[^<]*<\/h2><p[^>]*>(\d+ holders? holds?)[^<]*?: ([^<]*)</,
      }
    )
    return [
      `${read(page.dailyHolders, "days")}, ${read(page.majorHolders, "months")}`,
      `daily ${found.get("daily") ?? "none"}, ${found.get("earlier") ?? 0} earlier`,
      `major ${found.get("major") ?? "none"}`,
      `${rows} rows`,
    ].join("; ")
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
    Effect.tap((message) =>
      Effect.sync(() => parentPort?.postMessage(message))
    ),
    Effect.provideService(HoldingsDb, workerHoldingsDb(db))
  )
)
