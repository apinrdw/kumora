import { IconCheck, IconRefresh, IconX } from "@tabler/icons-react"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import {
  MarkLegend,
  type MarkStyle,
  MonthGrid,
} from "@/components/admin/archive/month-grid"
import type {
  ParseCoverage,
  ParseCoverageState,
} from "@/server/holdings/parse-coverage"

// Each state differs in shape as well as color: a filled square with a
// check, a filled square with a refresh arrow, an outlined square with a
// cross, an empty dashed square.
const STATE = {
  parsed: {
    label: "Parsed",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  stale: {
    label: "Stale",
    className: "border-warning/70 bg-warning/20 text-warning",
    Icon: IconRefresh,
  },
  failed: {
    label: "Failed",
    className: "border-down/80 text-down",
    Icon: IconX,
  },
  "not-parsed": {
    label: "Not parsed yet",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<ParseCoverageState, MarkStyle>

/**
 * Each grid's report kind: every archived month's parse coverage
 * (server/holdings/parse-coverage.ts), titled by the kind. Read-only: Parse
 * now on the parse run card parses every month not parsed.
 */
export function ParseCoverageCard({
  grids,
}: {
  grids: ReadonlyArray<{ title: string; coverage: ParseCoverage }>
}) {
  return (
    <ArchiveCard title="Parse coverage" aside={null}>
      <MarkLegend styles={Object.values(STATE)} />
      <div className="grid gap-6 lg:grid-cols-2">
        {grids.map(({ title, coverage }) =>
          coverage.length === 0 ? (
            <div key={title} className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold">{title}</h3>
              <p className="text-[13px] text-muted-foreground">
                No {title} report is archived yet.
              </p>
            </div>
          ) : (
            <MonthGrid
              key={title}
              title={title}
              label={`${title} parse coverage`}
              years={coverage}
              mark={({ state }) => STATE[state]}
              describe={({ date }) => `(${date})`}
            />
          )
        )}
      </div>
    </ArchiveCard>
  )
}
