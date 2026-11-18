import { IconChevronRight, IconHistory } from "@tabler/icons-react"
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
import {
  Callout,
  Note,
  NoteItem,
  NoteList,
} from "@/components/admin/archive/notes"

function Filenames({
  label,
  filenames,
}: {
  label: string
  filenames: ReadonlyArray<string>
}) {
  return (
    <NoteList label={label} data>
      {filenames.map((filename) => (
        <NoteItem key={filename}>{filename}</NoteItem>
      ))}
    </NoteList>
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
    <Callout>
      {listingFailures.length > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              listingFailures.length,
              "listing could not be read.",
              "listings could not be read."
            )
          )}
        >
          The run skipped its KSEI reports; the next run reads it again.
          <NoteList label="Listings not read">
            {listingFailures.map(({ kind, message }) => (
              <NoteItem key={kind}>
                <b className="font-semibold">{KIND_LABEL[kind]}:</b> {message}
              </NoteItem>
            ))}
          </NoteList>
        </Note>
      )}
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
          <Filenames label="Not stored" filenames={notStored} />
        </Note>
      )}
      {md5Mismatches.length > 0 && (
        <Note
          lead={Effect.runSync(
            count(
              md5Mismatches.length,
              "report's MD5 differs",
              "reports' MD5s differ"
            )
          )}
        >
          from KSEI's ETag.{" "}
          {md5Mismatches.length === 1 ? "It was" : "They were"} stored anyway.
          <Filenames label="MD5 mismatches" filenames={md5Mismatches} />
        </Note>
      )}
    </Callout>
  )
}

// The months of one kind no probe found, a row per year: "2019: 05, 07".
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
    <Note lead={`${KIND_LABEL[kind]}:`}>
      {Effect.runSync(count(months.length, "month", "months"))} not found.
      {months.length > 0 && (
        <NoteList label={`${KIND_LABEL[kind]} months not found`} data>
          {[...years].map(([year, ofYear]) => (
            <NoteItem key={year}>
              {year}: {ofYear.map((month) => month.slice(5)).join(", ")}
            </NoteItem>
          ))}
        </NoteList>
      )}
    </Note>
  )
}

// What a Deep backfill found beyond the listings, collapsed under a row
// that says it in one line.
function DeepDetail({ deep }: { deep: DeepFinds }) {
  const { foundFromSeed, foundByProbing, monthsNotFound, probeFailures } = deep
  const notFound = KseiReportKind.literals.reduce(
    (sum, kind) => sum + monthsNotFound[kind].length,
    0
  )
  return (
    <details className="group bg-canvas/40 rounded-sm border border-border text-sm leading-5">
      <summary className="hover:bg-elevated flex cursor-pointer list-none items-start gap-2 rounded-sm px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <IconChevronRight
          aria-hidden
          className="text-secondary-text mt-0.5 size-4 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          stroke={2}
        />
        <span>
          Deep backfill:{" "}
          {Effect.runSync(count(foundFromSeed.length, "report", "reports"))}{" "}
          from the seed,{" "}
          {Effect.runSync(count(foundByProbing.length, "report", "reports"))} by
          probing, {Effect.runSync(count(notFound, "month", "months"))} not
          found.
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-4 pt-3 pb-4">
        {foundFromSeed.length > 0 && (
          <Note lead="Found from the seed">
            <Filenames label="Found from the seed" filenames={foundFromSeed} />
          </Note>
        )}
        {foundByProbing.length > 0 && (
          <Note lead="Found by probing">
            <Filenames label="Found by probing" filenames={foundByProbing} />
          </Note>
        )}
        {KseiReportKind.literals.map((kind) => (
          <MonthsNotFound
            key={kind}
            kind={kind}
            months={monthsNotFound[kind]}
          />
        ))}
        {probeFailures.length > 0 && (
          <Note
            lead={Effect.runSync(
              count(probeFailures.length, "probe failed.", "probes failed.")
            )}
          >
            Their months weren't looked at; the next deep backfill probes them
            again.
            <NoteList label="Probes failed">
              {probeFailures.map(({ kind, year, message }) => (
                <NoteItem key={`${kind}-${year}`}>
                  <b className="font-semibold">
                    {KIND_LABEL[kind]} {year}:
                  </b>{" "}
                  {message}
                </NoteItem>
              ))}
            </NoteList>
          </Note>
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
              {
                value: result.md5Mismatches.length,
                label: "MD5 mismatches",
                problem: true,
              },
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
