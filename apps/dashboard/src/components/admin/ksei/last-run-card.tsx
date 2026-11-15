import { IconHistory } from "@tabler/icons-react"
import { Effect } from "effect"

import { KBadge } from "@/components/k"
import { count } from "@/lib/format"
import { deepBackfillKseiFn, runKseiNowFn } from "@/server/admin/ksei.functions"
import type { RunView } from "@/server/archive/run-view"
import { KIND_LABEL, KseiReportKind } from "@/server/ksei/kind"
import type { DeepFinds, KseiRunResult } from "@/server/ksei/run-result"
import { KSEI_TIMES_WIB } from "@/server/ksei/schedule"

import {
  ArchiveLastRunCard,
  archiveRunStats,
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

// What a partial run couldn't read or store, and the KSEI reports whose MD5
// isn't their ETag.
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
          The run skipped its KSEI reports; the next run reads it again.
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

// The months of one kind no probe found, a line per year: "2019: 05, 07".
function MonthsNotFound({
  kind,
  months,
}: {
  kind: KseiReportKind
  months: ReadonlyArray<string>
}) {
  const years = new Map<string, Array<string>>()
  for (const month of months)
    years.set(month.slice(0, 4), [
      ...(years.get(month.slice(0, 4)) ?? []),
      month,
    ])
  return (
    <div>
      <b>{KIND_LABEL[kind]}:</b>{" "}
      {Effect.runSync(count(months.length, "month", "months"))} not found.
      {months.length > 0 && (
        <ul
          aria-label={`${KIND_LABEL[kind]} months not found`}
          className="mt-1 list-disc pl-5"
        >
          {[...years].map(([year, ofYear]) => (
            <li key={year} className="num text-xs">
              {year}: {ofYear.map((month) => month.slice(5)).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// What a Deep backfill found beyond the listings, collapsed.
function DeepDetail({ deep }: { deep: DeepFinds }) {
  const { foundFromSeed, foundByProbing, monthsNotFound, probeFailures } = deep
  const notFound = KseiReportKind.literals.reduce(
    (sum, kind) => sum + monthsNotFound[kind].length,
    0
  )
  return (
    <details className="bg-elevated rounded-xs px-3 py-2 text-[13px]">
      <summary className="cursor-pointer">
        Deep backfill:{" "}
        {Effect.runSync(count(foundFromSeed.length, "report", "reports"))} from
        the seed,{" "}
        {Effect.runSync(count(foundByProbing.length, "report", "reports"))} by
        probing, {Effect.runSync(count(notFound, "month", "months"))} not found.
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {foundFromSeed.length > 0 && (
          <div>
            <b>Found from the seed</b>
            <Filenames label="Found from the seed" filenames={foundFromSeed} />
          </div>
        )}
        {foundByProbing.length > 0 && (
          <div>
            <b>Found by probing</b>
            <Filenames label="Found by probing" filenames={foundByProbing} />
          </div>
        )}
        {KseiReportKind.literals.map((kind) => (
          <MonthsNotFound
            key={kind}
            kind={kind}
            months={monthsNotFound[kind]}
          />
        ))}
        {probeFailures.length > 0 && (
          <div>
            <b>
              {Effect.runSync(
                count(probeFailures.length, "probe failed.", "probes failed.")
              )}
            </b>{" "}
            Their months weren't looked at; the next deep backfill probes them
            again.
            <ul aria-label="Probes failed" className="mt-1 list-disc pl-5">
              {probeFailures.map(({ kind, year, message }) => (
                <li
                  key={`${kind}-${year}`}
                  className="[overflow-wrap:anywhere]"
                >
                  <b>
                    {KIND_LABEL[kind]} {year}:
                  </b>{" "}
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

/**
 * The last KSEI archive run, or the empty state before any, with Run now and
 * Deep backfill.
 */
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
  const inProgress = lastRun?.inProgress ?? false
  return (
    <ArchiveLastRunCard
      title={
        <>
          Last KSEI archive run
          {result?.trigger === "deep" && (
            <KBadge tone="accent" icon={false}>
              Deep backfill
            </KBadge>
          )}
        </>
      }
      emptyMessage="No KSEI archive run has happened yet."
      lastRun={lastRun}
      now={now}
      stats={
        result === undefined
          ? []
          : [
              ...Effect.runSync(archiveRunStats(result)),
              { value: result.md5Mismatches.length, label: "MD5 mismatches" },
            ]
      }
      details={
        result === undefined ? null : (
          <>
            <Detail result={result} />
            {result.deep !== null && <DeepDetail deep={result.deep} />}
          </>
        )
      }
      actions={
        <div className="flex flex-wrap items-start gap-2">
          <RunArchiveButton inProgress={inProgress} start={runKseiNowFn}>
            Run now
          </RunArchiveButton>
          <RunArchiveButton
            inProgress={inProgress}
            start={deepBackfillKseiFn}
            icon={IconHistory}
            variant="secondary"
            note={false}
            confirm={{
              title: "Start a deep backfill?",
              description: "Probes about 2,000 URLs on ksei.co.id.",
              confirmLabel: "Deep backfill",
            }}
          >
            Deep backfill
          </RunArchiveButton>
        </div>
      }
      schedule={{ times: KSEI_TIMES_WIB, nextRun }}
    />
  )
}
