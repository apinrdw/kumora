import { IconFileAnalytics } from "@tabler/icons-react"
import { Effect } from "effect"

import { count } from "@/lib/format"
import { parseKseiNowFn } from "@/server/admin/ksei.functions"
import type { RunView } from "@/server/archive/run-view"
import type { KseiParseRunResult } from "@/server/ksei/parse-run-result"
import { KSEI_PARSE_TIMES_WIB } from "@/server/ksei/schedule"

import {
  ArchiveLastRunCard,
  RunArchiveButton,
} from "@/components/admin/archive/last-run-card"

// The period ends a partial run couldn't parse, each with why.
function Failures({ result }: { result: KseiParseRunResult }) {
  const { parseFailures } = result
  if (parseFailures.length === 0) return null
  return (
    <div className="border-warning bg-elevated rounded-xs border-l-[3px] px-3 py-2 text-[13px]">
      <b>
        {Effect.runSync(
          count(
            parseFailures.length,
            "month could not be parsed.",
            "months could not be parsed."
          )
        )}
      </b>{" "}
      {parseFailures.length === 1 ? "It keeps its" : "They keep their"} earlier
      parsed holdings; the next run tries again.
      <ul aria-label="Parse failures" className="mt-1 list-disc pl-5">
        {parseFailures.map(({ periodEnd, message }) => (
          <li key={periodEnd} className="[overflow-wrap:anywhere]">
            <b className="num">{periodEnd}:</b> {message}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The last KSEI parse run, or the empty state before any, with Parse now.
 */
export function KseiParseRunCard({
  lastParseRun,
  nextParseRun,
  now,
}: {
  lastParseRun: RunView<KseiParseRunResult> | undefined
  nextParseRun: string
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const result = lastParseRun?.result
  return (
    <ArchiveLastRunCard
      title="Last parse run"
      emptyMessage="No KSEI parse run has happened yet."
      lastRun={lastParseRun}
      now={now}
      stats={
        result === undefined
          ? []
          : [
              { value: result.monthsParsed, label: "Months parsed" },
              { value: result.parseFailures.length, label: "Parse failures" },
            ]
      }
      details={result === undefined ? null : <Failures result={result} />}
      actions={
        <RunArchiveButton
          inProgress={lastParseRun?.inProgress ?? false}
          start={parseKseiNowFn}
          icon={IconFileAnalytics}
        >
          Parse now
        </RunArchiveButton>
      }
      schedule={{ times: KSEI_PARSE_TIMES_WIB, nextRun: nextParseRun }}
    />
  )
}
