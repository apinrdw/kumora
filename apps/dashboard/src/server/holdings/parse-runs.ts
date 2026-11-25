// One kind of parse run on the shared run machinery (../archive/): its run
// itself, `reconcile`, one `parse:<date>` step per month to parse
// (parse-steps.ts), what it derives from them if anything, then `summary`; its runs in ArchiveDb; its starts and
// its last run. Each kind has its own Workflow, which it names by its own
// service and the machinery uses as its ArchiveWorkflow, so one layer can
// hold an archive's run Workflow and its parse runs' Workflows. Each kind's
// runs are apart from another's: their own records and their own one run in
// progress. Spec apinrdw/kumora#363, "KSEI parse run", and #402, "Parse
// runs".
import type { StepFailed, WorkflowSteps } from "@workspace/server"
import { type Context, DateTime, Effect } from "effect"

import type { ArchiveDb } from "../archive/archive-db.ts"
import type { ArchiveBucket } from "../archive/bucket.ts"
import { failingRun } from "../archive/failing-run.ts"
import {
  type ArchiveSource,
  dailyRunIdAt,
  type Run,
  type RunArchive,
  type RunId,
  type RunKind,
  runError,
} from "../archive/run.ts"
import {
  allReads,
  bothReads,
  mapRead,
  type PageRead,
  type Rows,
} from "../archive/page-read.ts"
import {
  lastRunRead,
  latestRunWhereRead,
  scheduledRun,
  startRunOf,
} from "../archive/runs.ts"
import { writeRunRow } from "../archive/run-rows.ts"
import type { NewestVersion } from "../archive/report-index.ts"
import { ArchiveWorkflow } from "../archive/workflow.ts"
import type { HoldingsDb } from "./db.ts"
import {
  type ParseCoverageMonth,
  parseCoverageCells,
} from "./parse-coverage.ts"
import {
  ParseRunResult,
  ParseRunSummary,
  ParseTrigger,
  runningParseResult,
} from "./parse-run-result.ts"
import {
  type Derived,
  deriveDates,
  type MonthSource,
  type Parses,
  parseMonths,
} from "./parse-steps.ts"

type ParseRun = Run<ParseTrigger>

// Each trigger's last finished run: a run in progress is passed over for the
// one before it.
const finished = (run: ParseRunResult) => run.outcome !== "running"
const FINISHED = { cron: finished, admin: finished } satisfies Record<
  ParseTrigger,
  typeof finished
>

// A kind's Workflow, as its own service.
type ParseWorkflow<Self> = Context.Key<
  Self,
  Context.Service.Shape<typeof ArchiveWorkflow>
>

// A plain function, not an Effect: each kind calls it once at
// module load, and it only returns the kind's run, last run and starts as
// Effects, doing no work and never failing. As an Effect, each caller would
// only Effect.runSync it at module load, the reason CODING_STANDARDS spares
// a Layer's `make`.
export const parseRunsOf = <Self, Coverage>(kind: {
  // How a log line names one of its runs, as "KSEI parse run".
  readonly runName: string
  readonly archive: RunArchive
  readonly runKind: RunKind
  // Where its run records and latest pointer lived in its archive's bucket,
  // for the cutover import.
  readonly runsPrefix: string
  readonly months: MonthSource
  // Each archived date, oldest first, with its newest version's SHA-256,
  // from the report index: what the parse coverage reads in place of a
  // listing of the months' prefix.
  readonly newestVersions: PageRead<ReadonlyArray<NewestVersion>>
  // How the parse coverage lays out its cells: year by month
  // (parseCoverageByMonth) or, for a daily kind, month by day
  // (parseCoverageByDay).
  readonly coverageLayout: (
    cells: ReadonlyArray<ParseCoverageMonth>
  ) => Effect.Effect<Coverage>
  readonly workflow: ParseWorkflow<Self>
  // What it derives from its parsed holdings once they are parsed, if
  // anything.
  readonly derived?: Derived
}) => {
  const source = {
    runName: kind.runName,
    archive: kind.archive,
    runKind: kind.runKind,
    runsPrefix: kind.runsPrefix,
    triggers: ParseTrigger.literals,
    runIdAt: dailyRunIdAt,
    result: ParseRunResult,
    summary: ParseRunSummary,
    readersPastRetention: FINISHED,
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
    yield* writeRunRow(source, result)
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
    yield* writeRunRow(source, result)
    return result
  })

  // Each trigger's last finished run.
  const lastFinished = ParseTrigger.literals.map((trigger) =>
    latestRunWhereRead(source, trigger)
  )

  const lastRun = lastRunRead(source)

  return {
    // The kind's parse coverage, for the admin page, laid out by
    // `coverageLayout`: the months' newest
    // versions, and its last finished run, of either trigger, whose parse
    // failures mark months failed. A run in progress is passed over for the
    // one before it.
    parseCoverage: mapRead(
      bothReads(kind.newestVersions, allReads(lastFinished)),
      ([newestVersions, runs]) =>
        parseCoverageCells(
          kind.months,
          newestVersions,
          runs.reduce<ParseRunResult | undefined>(
            (latest, run) =>
              run !== undefined &&
              (latest === undefined || run.startedAt > latest.startedAt)
                ? run
                : latest,
            undefined
          )
        ).pipe(Effect.flatMap(kind.coverageLayout))
    ),
    // The run its Workflow runs.
    run: Effect.fn(kind.runName)(function* (
      steps: WorkflowSteps<ArchiveBucket | ArchiveDb | HoldingsDb>,
      run: ParseRun
    ): Effect.fn.Return<ParseRunResult, StepFailed> {
      const parses = yield* failingRun(
        steps,
        parseMonths(steps, kind.months),
        (message) => recordReconcileFailure(run, message)
      )
      const derived = kind.derived
      const deriveFailures =
        derived === undefined
          ? []
          : yield* failingRun(steps, deriveDates(steps, derived), (message) =>
              recordReconcileFailure(run, message)
            )
      return yield* steps.do(
        "summary",
        summary(run, {
          monthsParsed: parses.monthsParsed,
          parseFailures: [...parses.parseFailures, ...deriveFailures],
        })
      )
    }),
    // The last run, for the admin page: undefined before any run.
    last: {
      ...lastRun,
      read: (rows: ReadonlyArray<Rows>) => onWorkflow(lastRun.read(rows)),
    },
    start: (id: RunId, trigger: ParseTrigger) =>
      onWorkflow(startRunOf(source, id, trigger)),
    // What each cron firing runs: one run a day, named after its scheduled
    // date (UTC), unless a run is still in progress.
    scheduled: (scheduledTime: number) =>
      onWorkflow(scheduledRun(source, scheduledTime)),
  }
}

export type ParseRuns<Self> = ReturnType<typeof parseRunsOf<Self, unknown>>
