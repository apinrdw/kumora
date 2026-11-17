import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  ArchiveTotalsCard,
  RecentRunsCard,
} from "@/components/admin/shareholding/archive-history"
import { ParseRunCard } from "@/components/admin/archive/parse-run-card"
import { LastRunCard } from "@/components/admin/shareholding/last-run-card"
import { SectorsCard } from "@/components/admin/shareholding/sectors-card"
import { sectorTableFn } from "@/server/admin/sectors.functions"
import {
  parseClassificationNowFn,
  parseInvestorTypeNowFn,
  shareholdingArchiveFn,
} from "@/server/admin/shareholding.functions"
import { PARSE_TIMES_WIB } from "@/server/shareholding/schedule"

export const Route = createFileRoute("/_app/admin/shareholding")({
  staticData: {
    feature: "admin",
    crumbs: () =>
      Effect.succeed([{ label: "Admin" }, { label: "Shareholding archive" }]),
  },
  loader: () =>
    runLoader(
      Effect.all(
        {
          archive: loadServerFn(() => shareholdingArchiveFn()),
          sectors: loadServerFn(() => sectorTableFn()),
        },
        { concurrency: "unbounded" }
      )
    ),
  head: () => ({ meta: [{ title: "Shareholding archive · KUMORA Terminal" }] }),
  component: ShareholdingPage,
})

function ShareholdingPage() {
  const {
    archive: {
      recentRuns,
      totals,
      lastClassificationParseRun,
      lastInvestorTypeParseRun,
      nextParseRun,
      ...lastRun
    },
    sectors,
  } = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-5 py-6">
      <h1 className="text-2xl font-bold">Shareholding archive</h1>
      <LastRunCard {...lastRun} />
      <ParseRunCard
        title="Last classification parse run"
        emptyMessage="No classification parse run has happened yet."
        lastParseRun={lastClassificationParseRun}
        parseNow={parseClassificationNowFn}
        times={PARSE_TIMES_WIB}
        nextParseRun={nextParseRun}
        now={lastRun.now}
      />
      <ParseRunCard
        title="Last investor-type parse run"
        emptyMessage="No investor-type parse run has happened yet."
        lastParseRun={lastInvestorTypeParseRun}
        parseNow={parseInvestorTypeNowFn}
        times={PARSE_TIMES_WIB}
        nextParseRun={nextParseRun}
        now={lastRun.now}
      />
      <RecentRunsCard runs={recentRuns} />
      <ArchiveTotalsCard totals={totals} />
      <SectorsCard {...sectors} />
    </div>
  )
}
