import { Effect } from "effect"

import { count } from "@/lib/format"
import { runDisclosuresNowFn } from "@/server/admin/disclosures.functions"
import type { RunView } from "@/server/archive/run-view"
import type { DisclosureRunResult } from "@/server/disclosures/run-result"
import { DISCLOSURE_EVERY } from "@/server/disclosures/schedule"

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

// What a partial run left behind: the attachments it couldn't store and
// those past its budget, which wait for the next run, the older days it
// couldn't list, which the next run lists again, and the listing entries it
// skipped, which no run takes up again.
function Detail({ result }: { result: DisclosureRunResult }) {
  const { notStored, attachmentsWaiting, entriesSkipped, skipped } = result
  const { unlistedDays } = result
  const waits = attachmentsWaiting > 0 || notStored.length > 0
  if (!waits && entriesSkipped === 0 && unlistedDays.length === 0) return null
  return (
    <Callout>
      {waits && (
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
      )}
      {unlistedDays.length > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              unlistedDays.length,
              "older day couldn't be listed.",
              "older days couldn't be listed."
            )
          )}
        >
          {unlistedDays.length === 1
            ? "The next run lists it again:"
            : "The next run lists them again:"}
          <NoteList label="Not listed" data>
            {unlistedDays.map(({ day, message }) => (
              <NoteItem key={day}>
                {day}: {message}
              </NoteItem>
            ))}
          </NoteList>
        </Note>
      )}
      {entriesSkipped > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              entriesSkipped,
              "listing entry was skipped.",
              "listing entries were skipped."
            )
          )}
        >
          IDX listed them in a shape the archive can't key or download:
          <NoteList label="Skipped" data>
            {skipped.map((message) => (
              <NoteItem key={message}>{message}</NoteItem>
            ))}
          </NoteList>
        </Note>
      )}
    </Callout>
  )
}

/**
 * The last disclosure run, or the empty state before any, with Run now: a
 * card of its own.
 */
export function DisclosureLastRunCard({
  lastRun,
  nextRun,
  now,
}: {
  lastRun: RunView<DisclosureRunResult> | undefined
  nextRun: string
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
      schedule={{ every: DISCLOSURE_EVERY, nextRun }}
    />
  )
}
