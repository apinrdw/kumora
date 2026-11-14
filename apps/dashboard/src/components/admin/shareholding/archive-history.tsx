import { Effect } from "effect"

import {
  ArchiveRecentRunsCard,
  KindTotalsCard,
} from "@/components/admin/archive/history-cards"
import type { KColumn } from "@/components/k"
import { kindPrefix } from "@/server/shareholding/keys"
import type { ReportKind } from "@/server/shareholding/listing"
import type { RunSummary } from "@/server/shareholding/run-result"
import type { ArchiveTotals } from "@/server/shareholding/totals"

const COUNT_COLUMNS: ReadonlyArray<KColumn<RunSummary>> = [
  { key: "reportsAdded", label: "Added", align: "right" },
  { key: "newVersions", label: "New versions", align: "right" },
]

/** The runs of the past 30 days, newest first. */
export function RecentRunsCard({ runs }: { runs: ReadonlyArray<RunSummary> }) {
  return <ArchiveRecentRunsCard runs={runs} counts={COUNT_COLUMNS} />
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
    <KindTotalsCard
      title="Archive totals"
      reports={totals.reports}
      bytes={totals.bytes}
      emptyMessage="No shareholding report is archived yet."
      label="Reports per kind"
      columns={KIND_COLUMNS}
      rows={totals.kinds.map((row) => ({
        ...row,
        prefix: Effect.runSync(kindPrefix(row.kind)),
      }))}
      getRowId={(row) => row.kind}
    />
  )
}
