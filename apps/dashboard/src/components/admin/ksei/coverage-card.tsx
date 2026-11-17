import { IconCheck, IconX } from "@tabler/icons-react"
import { Effect } from "effect"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import {
  MarkLegend,
  type MarkStyle,
  MonthGrid,
} from "@/components/admin/archive/month-grid"
import { dateTime } from "@/lib/format"
import type { RunId } from "@/server/archive/run"
import type { CoverageState, KseiCoverage } from "@/server/ksei/coverage"
import { KIND_LABEL } from "@/server/ksei/kind"

// Each state differs in shape as well as color: a filled square with a
// check, an outlined square with a cross, an empty dashed square.
const STATE = {
  held: {
    label: "Held",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  "not-found": {
    label: "Not found",
    className: "border-down/80 text-down",
    Icon: IconX,
  },
  "never-looked-for": {
    label: "Never looked for",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<CoverageState, MarkStyle>

/**
 * Each KSEI report kind's months from the archive's first (FIRST_MONTH,
 * server/ksei/coverage.ts): held, not found by the latest
 * Deep backfill, or never looked for.
 */
export function KseiCoverageCard({
  coverage,
  lastDeepRun,
}: {
  coverage: KseiCoverage
  lastDeepRun:
    | { readonly id: RunId; readonly finishedAt: string | null }
    | undefined
}) {
  return (
    <ArchiveCard title="Coverage" aside={null}>
      <MarkLegend styles={Object.values(STATE)} />
      <p className="text-[13px] text-muted-foreground">
        {lastDeepRun === undefined ? (
          "No Deep backfill has run yet, so no month without a KSEI report has been looked for."
        ) : (
          <>
            Not found by the latest Deep backfill,{" "}
            <span className="font-mono whitespace-nowrap">
              {lastDeepRun.id}
            </span>
            {lastDeepRun.finishedAt !== null &&
              `, finished ${Effect.runSync(dateTime(lastDeepRun.finishedAt))}`}
            .
          </>
        )}
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        {coverage.map(({ kind, years }) => (
          // Blank before the archive's first month and after today's.
          <MonthGrid
            key={kind}
            title={KIND_LABEL[kind]}
            label={`${KIND_LABEL[kind]} coverage`}
            years={years}
            mark={(state) => STATE[state]}
          />
        ))}
      </div>
    </ArchiveCard>
  )
}
