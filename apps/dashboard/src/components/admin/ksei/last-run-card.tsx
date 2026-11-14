import { Effect } from "effect"

import { count } from "@/lib/format"
import { runKseiNowFn } from "@/server/admin/ksei.functions"
import type { RunView } from "@/server/archive/run-view"
import { KIND_LABEL } from "@/server/ksei/kind"
import type { KseiRunResult } from "@/server/ksei/run-result"
import { KSEI_TIMES_WIB } from "@/server/ksei/schedule"

import {
  ArchiveLastRunCard,
  RunArchiveButton,
} from "@/components/admin/archive/last-run-card"

function Filenames({
  label,
  filenames,
}: {
  label: string
  filenames: ReadonlyArray<string>
}) {
  return (
    <ul aria-label={label} className="mt-1 list-disc pl-5">
      {filenames.map((filename) => (
        <li key={filename} className="font-mono text-xs">
          {filename}
        </li>
      ))}
    </ul>
  )
}

// What a partial run couldn't read or store, and the files whose MD5 isn't
// their ETag.
function Detail({ result }: { result: KseiRunResult }) {
  const { listingFailures, notStored, md5Mismatches } = result
  if (
    listingFailures.length === 0 &&
    notStored.length === 0 &&
    md5Mismatches.length === 0
  )
    return null
  return (
    <div className="border-warning bg-elevated flex flex-col gap-2 rounded-xs border-l-[3px] px-3 py-2 text-[13px]">
      {listingFailures.length > 0 && (
        <div>
          <b>
            {Effect.runSync(
              count(
                listingFailures.length,
                "listing could not be read.",
                "listings could not be read."
              )
            )}
          </b>{" "}
          The run skipped its files; the next run reads it again.
          <ul aria-label="Listings not read" className="mt-1 list-disc pl-5">
            {listingFailures.map(({ kind, message }) => (
              <li key={kind} className="[overflow-wrap:anywhere]">
                <b>{KIND_LABEL[kind]}:</b> {message}
              </li>
            ))}
          </ul>
        </div>
      )}
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
          <Filenames label="Not stored" filenames={notStored} />
        </div>
      )}
      {md5Mismatches.length > 0 && (
        <div>
          <b>
            {Effect.runSync(
              count(
                md5Mismatches.length,
                "report's MD5 differs",
                "reports' MD5s differ"
              )
            )}
          </b>{" "}
          from KSEI's ETag.{" "}
          {md5Mismatches.length === 1 ? "It was" : "They were"} stored anyway.
          <Filenames label="MD5 mismatches" filenames={md5Mismatches} />
        </div>
      )}
    </div>
  )
}

/** The last KSEI archive run, or the empty state before any, with Run now. */
export function KseiLastRunCard({
  lastRun,
  nextRun,
  now,
}: {
  lastRun: RunView<KseiRunResult> | undefined
  nextRun: string
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const result = lastRun?.result
  return (
    <ArchiveLastRunCard
      title="Last KSEI archive run"
      emptyMessage="No KSEI archive run has happened yet."
      lastRun={lastRun}
      now={now}
      stats={
        result === undefined
          ? []
          : [
              { value: result.reportsAdded, label: "Reports added" },
              { value: result.newVersions, label: "New versions" },
              { value: result.reportsChecked, label: "Reports checked" },
              { value: result.notStored.length, label: "Not stored" },
              { value: result.md5Mismatches.length, label: "MD5 mismatches" },
            ]
      }
      details={result === undefined ? null : <Detail result={result} />}
      actions={
        <RunArchiveButton
          inProgress={lastRun?.inProgress ?? false}
          start={runKseiNowFn}
        >
          Run now
        </RunArchiveButton>
      }
      schedule={{ times: KSEI_TIMES_WIB, nextRun }}
    />
  )
}
