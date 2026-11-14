import { KBadge, KDataTable, type KColumn } from "@/components/k"
import type { ArchiveTotals } from "@/server/shareholding/history"
import type { ReportKind } from "@/server/shareholding/listing"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

import { Card, OUTCOME, plural, wib } from "./last-run-card"

const RUN_COLUMNS: ReadonlyArray<KColumn<ArchiveRunResult>> = [
  {
    key: "startedAt",
    label: "Started (WIB)",
    cell: (run) => wib(run.startedAt),
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
    <Card title="Recent runs" aside={null}>
      <KDataTable
        label="Recent runs"
        columns={RUN_COLUMNS}
        rows={runs}
        getRowId={(run) => run.id}
        state={
          runs.length === 0
            ? {
                status: "empty",
                title: "No archive run in the past 30 days.",
                description: "Runs show here for 30 days after they start.",
              }
            : { status: "ready" }
        }
      />
      <p className="text-xs text-muted-foreground">Kept 30 days.</p>
    </Card>
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

// 56.9 MB
const size = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
})
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const
const bytes = (n: number) => {
  const power = Math.min(
    n < 1000 ? 0 : Math.floor(Math.log10(n) / 3),
    UNITS.length - 1
  )
  return `${size.format(n / 1000 ** power)} ${UNITS[power]}`
}

/** The archive's stored reports per report kind, with its total and size. */
export function ArchiveTotalsCard({ totals }: { totals: ArchiveTotals }) {
  return (
    <Card
      title="Archive totals"
      aside={
        <span className="text-[13px] text-muted-foreground">
          {plural(totals.reports, "report", "reports")} · {bytes(totals.bytes)}
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
            prefix: `reports/${row.kind}/`,
          }))}
          getRowId={(row) => row.kind}
        />
      )}
    </Card>
  )
}
