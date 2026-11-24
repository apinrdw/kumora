// An admin page's view of an archive's runs over time: the runs of the past
// 30 days (spec apinrdw/kumora#303, "The admin page").
import { DateTime, Effect } from "effect"

import { RETENTION_MS } from "./retention.ts"
import { type RunBase, type ArchiveSource, type RunSummaryBase } from "./run.ts"
import type { Rows } from "./page-read.ts"
import { importedKind } from "./run-import.ts"
import { decodeRuns, recentRunsStatement } from "./run-rows.ts"
import { endedRunError } from "./run-view.ts"
import { ArchiveWorkflow, type WorkflowError } from "./workflow.ts"

// The runs started in the 30 days to `now`, newest first, each shown as the
// last run card shows it, from their rows' summaries.
export const recentRunsRead = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  now: DateTime.Utc
) => ({
  kinds: [importedKind(source)],
  statements: [
    recentRunsStatement(source, DateTime.toEpochMillis(now) - RETENTION_MS),
  ],
  read: ([rows = []]: ReadonlyArray<Rows>) =>
    Effect.gen(function* () {
      const workflow = yield* ArchiveWorkflow
      const recent = yield* decodeRuns(source.summary, rows)
      // Only a record that still says running needs its instance's status.
      return yield* Effect.forEach(
        recent,
        (run): Effect.Effect<Summary, WorkflowError> =>
          Effect.gen(function* () {
            if (run.outcome !== "running") return run
            const instance = yield* workflow.status(run.id)
            const ended = yield* endedRunError(
              run,
              instance,
              DateTime.toEpochMillis(now)
            )
            return ended === undefined
              ? run
              : { ...run, outcome: "failed" as const }
          }),
        { concurrency: 10 }
      )
    }),
})
