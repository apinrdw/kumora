import { Effect } from "effect"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import { FLUSH } from "@/components/admin/archive/history-cards"
import { KDataTable, type KColumn } from "@/components/k"
import { count, dateTime } from "@/lib/format"
import type { UnavailableAttachments } from "@/server/disclosures/disclosure-index"

type Row = UnavailableAttachments["attachments"][number]

const data = (text: string) => (
  <span className="font-data text-xs break-all">{text}</span>
)

const COLUMNS: ReadonlyArray<KColumn<Row>> = [
  {
    key: "unavailableAt",
    label: "Unavailable since (WIB)",
    cell: (row) => Effect.runSync(dateTime(row.unavailableAt)),
  },
  {
    key: "disclosure",
    label: "Disclosure",
    cell: (row) => data(row.disclosure),
  },
  { key: "path", label: "Attachment", cell: (row) => data(row.path) },
  {
    key: "firstFailedAt",
    label: "First failed (WIB)",
    cell: (row) => Effect.runSync(dateTime(row.firstFailedAt)),
  },
  { key: "lastError", label: "Last failure" },
]

/**
 * The attachments IDX lists that no run could download for 7 days, newest
 * first: no run tries them again, and their days may be complete without
 * them (server/disclosures/disclosure-index.ts).
 */
export function DisclosureUnavailableCard({
  unavailable: { total, attachments },
}: {
  unavailable: UnavailableAttachments
}) {
  return (
    <ArchiveCard
      title="Unavailable attachments"
      aside={
        <span className="font-data text-secondary-text text-[13px]">
          {total}
        </span>
      }
    >
      <KDataTable<Row>
        label="Unavailable attachments"
        columns={COLUMNS}
        rows={attachments}
        getRowId={(row) => `${row.disclosure} ${row.path}`}
        className={FLUSH}
        state={
          total === 0
            ? {
                status: "empty",
                title: "No attachment is unavailable.",
                description:
                  "An attachment no run could download for 7 days shows here.",
              }
            : { status: "ready" }
        }
      />
      <p className="text-secondary-text text-[13px]">
        {attachments.length < total
          ? `The newest ${attachments.length} of ${Effect.runSync(count(total, "attachment", "attachments"))}. `
          : ""}
        No run tries them again.
      </p>
    </ArchiveCard>
  )
}
