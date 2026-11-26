import { Effect } from "effect"

import { count } from "@/lib/format"
import { runDisclosuresNowFn } from "@/server/admin/disclosures.functions"
import type { RunView } from "@/server/archive/run-view"
import type { DisclosureRunResult } from "@/server/disclosures/run-result"

import {
  ArchiveLastRunCard,
  RunArchiveButton,
} from "@/components/admin/archive/last-run-card"
import {
  Callout,
  Note,
  NoteItem,
  NoteList,
} from "@/components/admin/archive/notes"

// What a partial run left waiting: the attachments it couldn't store, and
// those past its budget.
function Detail({ result }: { result: DisclosureRunResult }) {
  const { notStored, attachmentsWaiting } = result
  if (attachmentsWaiting === 0 && notStored.length === 0) return null
  return (
    <Callout>
      <Note
        lead={Effect.runSync(
          count(
            attachmentsWaiting,
            "attachment waits for the next run.",
            "attachments wait for the next run."
          )
        )}
      >
        {notStored.length > 0
          ? "Some could not be downloaded:"
          : "The run stored as many as one run stores."}
        {notStored.length > 0 && (
          <NoteList label="Not stored" data>
            {notStored.map(({ disclosure, path, message }) => (
              <NoteItem key={`${disclosure}${path}`}>
                {path} ({disclosure}): {message}
              </NoteItem>
            ))}
          </NoteList>
        )}
      </Note>
    </Callout>
  )
}

/**
 * The last disclosure run, or the empty state before any, with Run now: a
 * card of its own.
 */
export function DisclosureLastRunCard({
  lastRun,
  now,
}: {
  lastRun: RunView<DisclosureRunResult> | undefined
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const result = lastRun?.result
  return (
    <ArchiveLastRunCard
      title="Last disclosure run"
      emptyMessage="No disclosure run has happened yet."
      lastRun={lastRun}
      now={now}
      stats={
        result === undefined
          ? []
          : [
              { value: result.versionsAdded, label: "Versions added" },
              { value: result.attachmentsStored, label: "Attachments stored" },
              {
                value: result.attachmentsWaiting,
                label: "Attachments waiting",
                tone: "warning",
              },
            ]
      }
      details={result === undefined ? null : <Detail result={result} />}
      actions={
        <RunArchiveButton
          inProgress={lastRun?.inProgress ?? false}
          start={runDisclosuresNowFn}
        >
          Run now
        </RunArchiveButton>
      }
    />
  )
}
