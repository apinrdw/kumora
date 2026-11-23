import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  ArchiveTotalsCard,
  RecentRunsCard,
} from "@/components/admin/shareholding/archive-history"
import { ArchiveLedger } from "@/components/admin/archive/archive-card"
import { ParseCoverageCard } from "@/components/admin/archive/parse-coverage-card"
import { ParseRunCard } from "@/components/admin/archive/parse-run-card"
import { LastRunCard } from "@/components/admin/shareholding/last-run-card"
import { SectorsCard } from "@/components/admin/shareholding/sectors-card"
import { sectorTableFn } from "@/server/admin/sectors.functions"
import {
  parseAbove1NowFn,
  parseClassificationNowFn,
  parseInvestorTypeNowFn,
  shareholdingArchiveFn,
} from "@/server/admin/shareholding.functions"
import { KIND_LABEL } from "@/server/shareholding/kind"
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
      lastAbove1ParseRun,
      nextParseRun,
      classificationParseCoverage,
      investorTypeParseCoverage,
      ...lastRun
    },
    sectors,
  } = Route.useLoaderData()
  // The jobs read as one ledger, a row each on shared columns, so
  // their outcomes and counts compare at a glance; the history, totals and
  // coverage follow as panels of their own.
  return (
    <div className="flex flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.01em]">
          Shareholding archive
        </h1>
        <p className="text-secondary-text max-w-[70ch]">
          IDX's shareholding reports: the runs that store and parse them, which
          months each kind holds, and the sector table.
        </p>
      </header>
      <ArchiveLedger
        title="Jobs"
        description="Times in WIB. Run now and Parse now start a job on this stage."
      >
        <LastRunCard {...lastRun} />
        <ParseRunCard
          title="Last classification parse run"
          emptyMessage="No classification parse run has happened yet."
          lastParseRun={lastClassificationParseRun}
          parseNow={parseClassificationNowFn}
          times={PARSE_TIMES_WIB}
          nextParseRun={nextParseRun}
          now={lastRun.now}
          frame="row"
        />
        <ParseRunCard
          title="Last investor-type parse run"
          emptyMessage="No investor-type parse run has happened yet."
          lastParseRun={lastInvestorTypeParseRun}
          parseNow={parseInvestorTypeNowFn}
          times={PARSE_TIMES_WIB}
          nextParseRun={nextParseRun}
          now={lastRun.now}
          frame="row"
        />
        <ParseRunCard
          title="Last above-1% parse run"
          emptyMessage="No above-1% parse run has happened yet."
          lastParseRun={lastAbove1ParseRun}
          parseNow={parseAbove1NowFn}
          times={PARSE_TIMES_WIB}
          nextParseRun={nextParseRun}
          now={lastRun.now}
          frame="row"
        />
        <SectorsCard {...sectors} />
      </ArchiveLedger>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-2">
        <ParseCoverageCard
          grids={[
            {
              title: KIND_LABEL["investor-classification"],
              parseCoverage: classificationParseCoverage,
            },
            {
              title: KIND_LABEL["investor-type"],
              parseCoverage: investorTypeParseCoverage,
            },
          ]}
        />
        <ArchiveTotalsCard totals={totals} />
      </div>
      <RecentRunsCard runs={recentRuns} />
    </div>
  )
}
