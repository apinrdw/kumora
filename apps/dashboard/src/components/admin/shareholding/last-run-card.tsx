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

// What a run couldn't store or parse, and what it archived under `other`.
function Detail({ result }: { result: ArchiveRunResult }) {
  const { notStored, parseFailures, other } = result
  if (
    notStored.length === 0 &&
    parseFailures.length === 0 &&
    other.length === 0
  )
    return null
  return (
    <div className="border-warning bg-elevated flex flex-col gap-2 rounded-xs border-l-[3px] px-3 py-2 text-[13px]">
      {notStored.length > 0 && (
        <div>
          <b>
            {Effect.runSync(
              count(
                notStored.length,
                "report could not be stored.",
                "reports could not be stored."
              )
            )}
          </b>{" "}
          The next run retries {notStored.length === 1 ? "it" : "them"}.
          <ul aria-label="Not stored" className="mt-1 list-disc pl-5">
            {notStored.map((url) => (
              <li
                key={url}
                className="font-mono text-xs [overflow-wrap:anywhere]"
              >
                {url}
              </li>
            ))}
          </ul>
        </div>
      )}
      {parseFailures.length > 0 && (
        <div>
          <b>
            {Effect.runSync(
              count(
                parseFailures.length,
                "month could not be parsed.",
                "months could not be parsed."
              )
            )}
          </b>{" "}
          {parseFailures.length === 1 ? "It keeps its" : "Each keeps its"}{" "}
          earlier parsed holdings, and the next run tries again.
          <ul aria-label="Parse failures" className="mt-1 list-disc pl-5">
            {parseFailures.map(({ dataDate, reason }) => (
              <li key={dataDate} className="[overflow-wrap:anywhere]">
                <span className="font-mono text-xs">{dataDate}</span> {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {other.length > 0 && (
        <div>
          <b>
            {Effect.runSync(
              count(
                other.length,
                "report of an unknown kind",
                "reports of an unknown kind"
              )
            )}
          </b>{" "}
          {other.length === 1 ? "was" : "were"} archived under{" "}
          <span className="font-mono text-xs">other</span>.
          <ul aria-label="Archived under other" className="mt-1 list-disc pl-5">
            {other.map(({ sourceUrl, description }) => (
              <li key={sourceUrl} className="[overflow-wrap:anywhere]">
                {description}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {sourceUrl}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
        result === undefined
          ? []
          : [
              ...archiveRunStats(result),
              { value: result.monthsParsed, label: "Months parsed" },
              { value: result.parseFailures.length, label: "Parse failures" },
            ]
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
