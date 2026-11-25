import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"
import { loadServerFn, runLoader } from "@workspace/server/loader"

import {
  KseiRecentRunsCard,
  KseiTotalsCard,
} from "@/components/admin/ksei/archive-history"
import { KseiCoverageCard } from "@/components/admin/ksei/coverage-card"
import { KseiLastRunCard } from "@/components/admin/ksei/last-run-card"
import { ArchiveLedger } from "@/components/admin/archive/archive-card"
import { ParseCoverageCard } from "@/components/admin/archive/parse-coverage-card"
import { ParseRunCard } from "@/components/admin/archive/parse-run-card"
import { kseiArchiveFn, parseKseiNowFn } from "@/server/admin/ksei.functions"
import { KIND_LABEL } from "@/server/ksei/kind"
import { KSEI_PARSE_TIMES_WIB } from "@/server/ksei/schedule"

export const Route = createFileRoute("/_app/admin/ksei")({
  staticData: {
    feature: "admin",
    crumbs: () =>
      Effect.succeed([{ label: "Admin" }, { label: "KSEI archive" }]),
  },
  loader: () => runLoader(loadServerFn(() => kseiArchiveFn())),
  head: () => ({ meta: [{ title: "KSEI archive · KUMORA Terminal" }] }),
  component: KseiPage,
})

function KseiPage() {
  const {
    recentRuns,
    totals,
    coverage,
    lastDeepRun,
    lastParseRun,
    nextParseRun,
    parseCoverage,
    ...lastRun
  } = Route.useLoaderData()
  // The two jobs read as one ledger, as on the Shareholding archive page,
  // so their outcomes and counts compare at a glance; the coverage, totals
  // and history follow as panels of their own.
  return (
    <div className="flex flex-col gap-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.01em]">
          KSEI archive
        </h1>
        <p className="text-secondary-text max-w-[70ch] text-pretty">
          Every {KIND_LABEL["securities-statistics"]} and{" "}
          {KIND_LABEL["securities-holdings"]} report KSEI publishes, kept with
          each version, and the holdings parsed for the stock pages.
        </p>
      </header>
      <ArchiveLedger
        title="Jobs"
        description="Times in WIB. Run now, Deep backfill and Parse now start a job on this stage."
        // The archive run's counts and its MD5 mismatches.
        stats={5}
      >
        <KseiLastRunCard {...lastRun} />
        <ParseRunCard
          title="Last parse run"
          emptyMessage="No KSEI parse run has happened yet."
          lastParseRun={lastParseRun}
          parseNow={parseKseiNowFn}
          times={KSEI_PARSE_TIMES_WIB}
          nextParseRun={nextParseRun}
          now={lastRun.now}
          frame="row"
        />
      </ArchiveLedger>
      <KseiCoverageCard coverage={coverage} lastDeepRun={lastDeepRun} />
      {/* Side by side only from 2xl: narrower, half the width clips the
          totals' key prefixes. */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 2xl:grid-cols-2">
        <ParseCoverageCard
          grids={[
            {
              title: KIND_LABEL["securities-holdings"],
              layout: "month",
              parseCoverage,
            },
          ]}
        />
        <KseiTotalsCard totals={totals} />
      </div>
      <KseiRecentRunsCard runs={recentRuns} />
    </div>
  )
}
