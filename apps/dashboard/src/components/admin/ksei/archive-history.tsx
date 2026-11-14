import { Effect } from "effect"

import { KBadge } from "@/components/k"
import {
  ArchiveRecentRunsCard,
  KindTotalsCard,
} from "@/components/admin/archive/history-cards"
import type { KColumn } from "@/components/k"
import { byteSize } from "@/lib/format"
import { kindPrefix } from "@/server/ksei/keys"
import { KIND_LABEL } from "@/server/ksei/kind"
import type { KseiRunSummary } from "@/server/ksei/run-result"
import type { KseiTotals } from "@/server/ksei/totals"

const COUNT_COLUMNS: ReadonlyArray<KColumn<KseiRunSummary>> = [
  {
    key: "trigger",
    label: "Trigger",
    cell: (run) =>
      run.trigger === "deep" ? (
        <KBadge tone="accent" icon={false}>
          Deep backfill
        </KBadge>
      ) : null,
  },
  { key: "reportsAdded", label: "Added", align: "right" },
  { key: "newVersions", label: "New versions", align: "right" },
]

/** The KSEI archive runs of the past 30 days, newest first. */
export function KseiRecentRunsCard({
  runs,
}: {
  runs: ReadonlyArray<KseiRunSummary>
}) {
  return <ArchiveRecentRunsCard runs={runs} counts={COUNT_COLUMNS} />
}

type KindRow = KseiTotals["kinds"][number] & { readonly prefix: string }

const KIND_COLUMNS: ReadonlyArray<KColumn<KindRow>> = [
  { key: "kind", label: "Report kind", cell: (row) => KIND_LABEL[row.kind] },
  {
    key: "prefix",
    label: "Key prefix",
    cell: (row) => <span className="font-mono text-xs">{row.prefix}</span>,
  },
  { key: "reports", label: "Reports", align: "right" },
  { key: "versions", label: "Versions", align: "right" },
  {
    key: "bytes",
    label: "Size",
    align: "right",
    cell: (row) => Effect.runSync(byteSize(row.bytes)),
  },
]

/** The KSEI archive's reports, versions and size per KSEI report kind. */
export function KseiTotalsCard({ totals }: { totals: KseiTotals }) {
  return (
    <KindTotalsCard
      title="Archive totals"
      reports={totals.reports}
      bytes={totals.bytes}
      emptyMessage="No KSEI report is archived yet."
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
