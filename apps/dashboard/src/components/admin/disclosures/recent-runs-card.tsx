import { ArchiveRecentRunsCard } from "@/components/admin/archive/history-cards"
import type { KColumn } from "@/components/k"
import type { DisclosureRunSummary } from "@/server/disclosures/run-result"

const COUNT_COLUMNS: ReadonlyArray<KColumn<DisclosureRunSummary>> = [
  { key: "versionsAdded", label: "Versions added", align: "right" },
  { key: "attachmentsStored", label: "Attachments stored", align: "right" },
]

/** The disclosure runs of the past 30 days, newest first. */
export function DisclosureRecentRunsCard({
  runs,
}: {
  runs: ReadonlyArray<DisclosureRunSummary>
}) {
  return <ArchiveRecentRunsCard runs={runs} counts={COUNT_COLUMNS} />
}
