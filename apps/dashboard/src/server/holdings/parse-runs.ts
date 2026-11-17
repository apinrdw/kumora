// One kind of parse run on the shared run machinery (../archive/): its run
// itself, `reconcile`, one `parse:<date>` step per month to parse
// (parse-steps.ts), then `summary`; its run store under its runs prefix in
// its archive's bucket; its starts and its last run. Each kind has its own
// Workflow, which it names by its own service and the machinery uses as its
// ArchiveWorkflow, so one layer can hold an archive's run Workflow and its
// parse runs' Workflows. Each kind's runs are apart from another's: their
// own records and their own one run in progress. Spec apinrdw/kumora#363,
// "KSEI parse run", and #402, "Parse runs".
import type { StepFailed, WorkflowSteps } from "@workspace/server"
import { type Context, DateTime, Effect } from "effect"

import type { ArchiveBucket } from "../archive/bucket.ts"
import { failingRun } from "../archive/failing-run.ts"
import {
  type ArchiveSource,
  dailyRunIdAt,
  type Run,
  type RunId,
  runError,
} from "../archive/run.ts"
import {
  readLastRun,
  readLatestRunWhere,
  scheduledRun,
  startRunOf,
  writeRunRecord,
} from "../archive/runs.ts"
import { ArchiveWorkflow } from "../archive/workflow.ts"
import type { HoldingsDb } from "./db.ts"
import { parseCoverage } from "./parse-coverage.ts"
import {
  ParseRunMetadata,
  ParseRunResult,
  type ParseRunSummary,
  ParseTrigger,
  runningParseResult,
} from "./parse-run-result.ts"
import { type MonthSource, type Parses, parseMonths } from "./parse-steps.ts"

type ParseRun = Run<ParseTrigger>

// A kind's Workflow, as its own service.
type ParseWorkflow<Self> = Context.Key<
  Self,
  Context.Service.Shape<typeof ArchiveWorkflow>
>

// Decision: a plain function, not an Effect: each kind calls it once at
// module load, and it only returns the kind's run, last run and starts as
// Effects, doing no work and never failing. As an Effect, each caller would
// only Effect.runSync it at module load, the reason CODING_STANDARDS spares
// a Layer's `make`.
export const parseRunsOf = <Self>(kind: {
  // How a log line names one of its runs, as "KSEI parse run".
  readonly runName: string
  // Where its run records and latest pointer live in its archive's bucket.
  readonly runsPrefix: string
  readonly months: MonthSource
  readonly workflow: ParseWorkflow<Self>
}) => {
  const source = {
    runName: kind.runName,
    runsPrefix: kind.runsPrefix,
    triggers: ParseTrigger.literals,
    runIdAt: dailyRunIdAt,
    result: ParseRunResult,
    metadata: ParseRunMetadata,
    running: runningParseResult,
  } satisfies ArchiveSource<ParseTrigger, ParseRunSummary, ParseRunResult>

  const onWorkflow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideServiceEffect(
      effect,
      ArchiveWorkflow,
      Effect.service(kind.workflow)
    )

  const finishedResult = Effect.fnUntraced(function* (run: ParseRun) {
    return {
      ...(yield* runningParseResult(run)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
    }
  })

  const summary = Effect.fnUntraced(function* (
    run: ParseRun,
    { monthsParsed, parseFailures }: Parses
  ) {
    const result = ParseRunResult.make({
      ...(yield* finishedResult(run)),
      outcome: parseFailures.length === 0 ? "complete" : "partial",
      monthsParsed,
      parseFailures,
    })
    yield* writeRunRecord(source, result)
    return result
  })

  // `reconcile` failed, so nothing was parsed: the run is failed with its
  // message.
  const recordReconcileFailure = Effect.fnUntraced(function* (
    run: ParseRun,
    error: string
  ) {
    const result = ParseRunResult.make({
      ...(yield* finishedResult(run)),
      outcome: "failed",
      error: yield* runError(error),
    })
    yield* writeRunRecord(source, result)
    return result
  })

  // The last finished run, of either trigger: undefined before any. A run
  // in progress is passed over for the one before it.
  const lastFinished = Effect.map(
    Effect.forEach(ParseTrigger.literals, (trigger) =>
      readLatestRunWhere(source, trigger, (run) => run.outcome !== "running")
    ),
    (runs) =>
      runs.reduce<ParseRunResult | undefined>(
        (latest, run) =>
          run !== undefined &&
          (latest === undefined || run.startedAt > latest.startedAt)
            ? run
            : latest,
        undefined
      )
  )

  return {
    // The kind's parse coverage, for the admin page.
    parseCoverage: Effect.flatMap(lastFinished, (run) =>
      parseCoverage(kind.months, run)
    ),
    // The run its Workflow runs.
    run: Effect.fn(kind.runName)(function* (
      steps: WorkflowSteps<ArchiveBucket | HoldingsDb>,
      run: ParseRun
    ): Effect.fn.Return<ParseRunResult, StepFailed> {
      const parses = yield* failingRun(
        steps,
        parseMonths(steps, kind.months),
        (message) => recordReconcileFailure(run, message)
      )
      return yield* steps.do("summary", summary(run, parses))
    }),
    // The last run, for the admin page: undefined before any run.
    last: onWorkflow(readLastRun(source)),
    start: (id: RunId, trigger: ParseTrigger) =>
      onWorkflow(startRunOf(source, id, trigger)),
    // What each cron firing runs: one run a day, named after its scheduled
    // date (UTC), unless a run is still in progress.
    scheduled: (scheduledTime: number) =>
      onWorkflow(scheduledRun(source, scheduledTime)),
  }
}

export type ParseRuns<Self> = ReturnType<typeof parseRunsOf<Self>>
