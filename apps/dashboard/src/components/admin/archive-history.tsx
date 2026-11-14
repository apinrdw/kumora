import { Effect } from "effect"

import { KBadge, KDataTable, type KColumn } from "@/components/k"
import { byteSize, count, dateTime } from "@/lib/format"
import type { ArchiveTotals } from "@/server/shareholding/history"
import { kindPrefix } from "@/server/shareholding/keys"
import type { ReportKind } from "@/server/shareholding/listing"
import { RETENTION_DAYS } from "@/server/shareholding/retention"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

import { ArchiveCard, OUTCOME } from "./archive-card"

const RUN_COLUMNS: ReadonlyArray<KColumn<ArchiveRunResult>> = [
  {
    key: "startedAt",
    label: "Started (WIB)",
    cell: (run) => Effect.runSync(dateTime(run.startedAt)),
  },
  {
    key: "id",
    label: "Run",
    cell: (run) => <span className="font-mono text-xs">{run.id}</span>,
  },
  {
    key: "outcome",
    label: "Outcome",
    cell: (run) => (
      <KBadge tone={OUTCOME[run.outcome].tone}>
        {OUTCOME[run.outcome].label}
      </KBadge>
    ),
  },
  { key: "reportsAdded", label: "Added", align: "right" },
  { key: "newVersions", label: "New versions", align: "right" },
]

/** The runs of the past 30 days, newest first. */
export function RecentRunsCard({
  runs,
}: {
  runs: ReadonlyArray<ArchiveRunResult>
}) {
  return (
    <ArchiveCard title="Recent runs" aside={null}>
      <KDataTable
        label="Recent runs"
        columns={RUN_COLUMNS}
        rows={runs}
        getRowId={(run) => run.id}
        state={
          runs.length === 0
            ? {
                status: "empty",
                title: `No archive run in the past ${RETENTION_DAYS} days.`,
                description: `Runs show here for ${RETENTION_DAYS} days after they start.`,
              }
            : { status: "ready" }
        }
      />
      <p className="text-xs text-muted-foreground">
        Kept {RETENTION_DAYS} days.
      </p>
    </ArchiveCard>
  )
}

const KIND_LABEL: Record<ReportKind, string> = {
  "above-5": "Holders above 5%",
  "above-1": "Holders above 1%",
  "investor-type": "By investor type",
  "investor-classification": "By investor classification",
  other: "Other",
}

type KindRow = ArchiveTotals["kinds"][number] & { readonly prefix: string }

const KIND_COLUMNS: ReadonlyArray<KColumn<KindRow>> = [
  { key: "kind", label: "Report kind", cell: (row) => KIND_LABEL[row.kind] },
  {
    key: "prefix",
    label: "Key prefix",
    cell: (row) => <span className="font-mono text-xs">{row.prefix}</span>,
  },
  { key: "reports", label: "Reports", align: "right" },
]

/** The archive's stored reports per report kind, with its total and size. */
export function ArchiveTotalsCard({ totals }: { totals: ArchiveTotals }) {
  return (
    <ArchiveCard
      title="Archive totals"
      aside={
        <span className="text-[13px] text-muted-foreground">
          {Effect.runSync(count(totals.reports, "report", "reports"))} ·{" "}
          {Effect.runSync(byteSize(totals.bytes))}
        </span>
      }
    >
      {totals.reports === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No shareholding report is archived yet.
        </p>
      ) : (
        <KDataTable
          label="Reports per kind"
          columns={KIND_COLUMNS}
          rows={totals.kinds.map((row) => ({
            ...row,
            prefix: Effect.runSync(kindPrefix(row.kind)),
          }))}
          getRowId={(row) => row.kind}
        />
      )}
    </ArchiveCard>
  )
}
