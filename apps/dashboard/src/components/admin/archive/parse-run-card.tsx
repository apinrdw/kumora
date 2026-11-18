// A parse run's last run card (../../../server/holdings/parse-runs.ts), with
// Parse now. Every kind of parse run shows the same card; the kind passes its
// title, its Parse now server function and its schedule.
import { IconFileAnalytics } from "@tabler/icons-react"
import { Effect } from "effect"

import { count } from "@/lib/format"
import type { RunView } from "@/server/archive/run-view"
import type { ParseRunResult } from "@/server/holdings/parse-run-result"

import { ArchiveLastRunCard, RunArchiveButton } from "./last-run-card"
import { Callout, Note, NoteItem, NoteList } from "./notes"

// The months a partial run couldn't parse, each with why.
function Failures({ result }: { result: ParseRunResult }) {
  const { parseFailures } = result
  if (parseFailures.length === 0) return null
  return (
    <Callout>
      <Note
        lead={Effect.runSync(
          count(
            parseFailures.length,
            "month could not be parsed.",
            "months could not be parsed."
          )
        )}
      >
        {parseFailures.length === 1 ? "It keeps its" : "They keep their"}{" "}
        earlier parsed holdings; the next run tries again.
        <NoteList label="Parse failures">
          {parseFailures.map(({ date, message }) => (
            <NoteItem key={date}>
              <b className="font-data font-semibold">{date}:</b> {message}
            </NoteItem>
          ))}
        </NoteList>
      </Note>
    </Callout>
  )
}

/** A kind's last parse run, or the empty state before any, with Parse now. */
export function ParseRunCard({
  title,
  emptyMessage,
  lastParseRun,
  parseNow,
  times,
  nextParseRun,
  now,
}: {
  // As "Last parse run".
  title: string
  // As "No KSEI parse run has happened yet."
  emptyMessage: string
  lastParseRun: RunView<ParseRunResult> | undefined
  // The kind's Parse now server function.
  parseNow: () => Promise<{ readonly id: string }>
  // When its cron starts a run, as "11:00 WIB".
  times: string
  nextParseRun: string
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const result = lastParseRun?.result
  return (
    <ArchiveLastRunCard
      title={title}
      emptyMessage={emptyMessage}
      lastRun={lastParseRun}
      now={now}
      stats={
        result === undefined
          ? []
          : [
              { value: result.monthsParsed, label: "Months parsed" },
              {
                value: result.parseFailures.length,
                label: "Parse failures",
                problem: true,
              },
            ]
      }
      details={result === undefined ? null : <Failures result={result} />}
      actions={
        <RunArchiveButton
          inProgress={lastParseRun?.inProgress ?? false}
          start={parseNow}
          icon={IconFileAnalytics}
        >
          Parse now
        </RunArchiveButton>
      }
      schedule={{ times, nextRun: nextParseRun }}
    />
  )
}
