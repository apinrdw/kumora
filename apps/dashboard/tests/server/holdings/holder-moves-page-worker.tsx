// A Node worker thread that holds a Holder moves read of `lines` lines, each
// a New or Off-list holder with the longest texts a parse keeps (ADR 0045)
// and a full Trend, and renders the Holder moves page from it as the
// server render does (holder-moves-heap.test.ts). It posts the lines the
// page counts and the table rows rendered, or the failure's message. Vite
// bundles it (`bundled` in bounded-heap.ts).
import { parentPort, workerData } from "node:worker_threads"

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { StockCode, WibDate } from "@workspace/relay"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { Effect } from "effect"

import { HolderMovesPage } from "@/components/holder-moves/holder-moves"
import { type MoveKind, TREND_PERIODS } from "@/domain/holdings"
import { holderMovesView } from "@/lib/holder-moves"
import type { HolderMovesRead } from "@/server/holdings/holder-moves"

import { serverRender } from "./server-render.ts"

const { kind, lines } = workerData as {
  readonly kind: MoveKind
  readonly lines: number
}

const padded = (text: string, length: number) => text.padEnd(length, "X")

const PERIOD = WibDate.make("2026-11-25")
const AGAINST = WibDate.make("2026-11-24")
const counts = {
  new: lines / 2,
  up: 0,
  down: 0,
  transfer: 0,
  offList: lines / 2,
}

// 50 stocks, as the derivation's test at the caps has.
const read: HolderMovesRead = {
  kind,
  periods: [AGAINST, PERIOD],
  period: PERIOD,
  against: AGAINST,
  lines: Array.from({ length: lines }, (_, at) => {
    const entered = at % 2 === 0
    return {
      code: StockCode.make(`S${String(at % 50).padStart(3, "0")}`),
      issuerName: padded(`ISSUER ${at % 50}`, 128),
      holder: padded(`HOLDER ${at}`, 128),
      name: padded(`HOLDER ${at}`, 256),
      aliases: [],
      renamedFrom: undefined,
      move: entered ? "new" : "off list",
      custodians: kind === "daily" ? [padded(`CUSTODIAN ${at}`, 128)] : [],
      shareChange: entered ? 1_000_000 + at : -1_000_000 - at,
      stake: entered ? { now: 500 + (at % 100) } : { before: 500 + (at % 100) },
      percentageChange: undefined,
      transfer: undefined,
      trend: Array.from({ length: TREND_PERIODS }, (_period, cell) =>
        cell === TREND_PERIODS - 1 ? (entered ? "in" : "out") : at + cell
      ),
    }
  }),
  rail: [{ period: PERIOD, counts }],
}

function Page() {
  const moves = Effect.runSync(holderMovesView(read))
  return (
    <TooltipProvider>
      <HolderMovesPage
        kind={kind}
        moves={moves}
        filter="all"
        search=""
        onFilter={() => {}}
        onSearch={() => {}}
        onPeriod={() => {}}
        onKind={() => {}}
      />
    </TooltipProvider>
  )
}

const router = createRouter({
  routeTree: createRootRoute({ component: Page }),
  history: createMemoryHistory({ initialEntries: ["/holder-moves"] }),
})

Effect.runFork(
  Effect.gen(function* () {
    yield* Effect.promise(() => router.load())
    const { rows, found } = yield* serverRender(
      <RouterProvider router={router} />,
      {
        moved: /(\d+ holders above \d% moved)/,
        crossed: /Entered or left the list · (?:<!-- -->)?(\d+)/,
      }
    )
    return `${found.get("moved") ?? "none"}, ${found.get("crossed") ?? 0} entered or left; ${rows} rows`
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed(String(cause))),
    Effect.tap((message) => Effect.sync(() => parentPort?.postMessage(message)))
  )
)
