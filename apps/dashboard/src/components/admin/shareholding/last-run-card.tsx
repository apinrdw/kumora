import { Effect } from "effect"

import { count } from "@/lib/format"
import { runArchiveNowFn } from "@/server/admin/shareholding.functions"
import type { RunView } from "@/server/archive/run-view"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"
import { ARCHIVE_TIMES_WIB } from "@/server/shareholding/schedule"

import {
  ArchiveLastRunCard,
  archiveRunStats,
  RunArchiveButton,
} from "@/components/admin/archive/last-run-card"
import {
  Callout,
  Note,
  NoteItem,
  NoteList,
} from "@/components/admin/archive/notes"

// What a run couldn't store, and what it archived under `other`.
function Detail({ result }: { result: ArchiveRunResult }) {
  const { notStored, other } = result
  if (notStored.length === 0 && other.length === 0) return null
  return (
    <Callout>
      {notStored.length > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              notStored.length,
              "report could not be stored.",
              "reports could not be stored."
            )
          )}
        >
          The next run retries {notStored.length === 1 ? "it" : "them"}.
          <NoteList label="Not stored" data>
            {notStored.map((url) => (
              <NoteItem key={url}>{url}</NoteItem>
            ))}
          </NoteList>
        </Note>
      )}
      {other.length > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              other.length,
              "report of an unknown kind",
              "reports of an unknown kind"
            )
          )}
        >
          {other.length === 1 ? "was" : "were"} archived under{" "}
          <span className="font-data text-xs">other</span>.
          <NoteList label="Archived under other">
            {other.map(({ sourceUrl, description }) => (
              <NoteItem key={sourceUrl}>
                {description}{" "}
                <span className="font-data text-secondary-text text-xs">
                  {sourceUrl}
                </span>
              </NoteItem>
            ))}
          </NoteList>
        </Note>
      )}
    </Callout>
  )
}

/** The last archive run, or the empty state before any, with Run now. */
export function LastRunCard({
  lastRun,
  nextRun,
  now,
}: {
  lastRun: RunView<ArchiveRunResult> | undefined
  nextRun: string
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const result = lastRun?.result
  return (
    <ArchiveLastRunCard
      title="Last archive run"
      emptyMessage="No archive run has happened yet."
      lastRun={lastRun}
      now={now}
      stats={
        result === undefined ? [] : Effect.runSync(archiveRunStats(result))
      }
      details={result === undefined ? null : <Detail result={result} />}
      actions={
        <RunArchiveButton
          inProgress={lastRun?.inProgress ?? false}
          start={runArchiveNowFn}
        >
          Run now
        </RunArchiveButton>
      }
      schedule={{ times: ARCHIVE_TIMES_WIB, nextRun }}
    />
  )
}
