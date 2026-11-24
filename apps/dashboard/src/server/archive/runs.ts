// An archive's run store and starting its runs: one ArchiveDb row per run
// (run-rows.ts), the one-run-at-a-time start from its cron or an admin page,
// and the last run the page shows. Spec apinrdw/kumora#303, "Starting a
// run", and #659. Each archive passes its ArchiveSource (run.ts) and
// provides its own ArchiveBucket, for the cutover import (run-import.ts), and
// its own ArchiveWorkflow.
import { DateTime, Effect, Schema } from "effect"

import type { ArchiveDbError } from "./archive-db.ts"
import { ArchiveDb } from "./archive-db.ts"
import type { ArchiveBucket, BucketError } from "./bucket.ts"
import { RETENTION } from "./retention.ts"
import {
  type ArchiveSource,
  type LatestWhere,
  type RunBase,
  RunId,
  type RunSummaryBase,
} from "./run.ts"
import type { Rows } from "./page-read.ts"
import { importedKind, importedRuns } from "./run-import.ts"
import {
  decodeRun,
  decodeRuns,
  lastRunStatement,
  RUN_COLUMNS,
  runRow,
  type RunKind,
  runStatement,
  triggerRunsStatement,
  writeRunRow,
} from "./run-rows.ts"
import { isInProgress, viewRun } from "./run-view.ts"
import {
  ArchiveWorkflow,
  DuplicateRunId,
  type WorkflowError,
} from "./workflow.ts"

// The run the kind's last start claimed is still in progress.
class RunInProgress extends Schema.TaggedError<RunInProgress>()(
  "RunInProgress",
  { id: RunId }
) {}

// Writes `result` as its run's row.
export const writeRunRecord = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  result: RunRecord
) => writeRunRow(source, result)

// The run the kind's last start claimed, judged against its instance's
// status: undefined before any run.
const judgeLatest = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  rows: ReadonlyArray<Record<string, unknown>>
) =>
  Effect.gen(function* () {
    const result = yield* decodeRun(source.result, rows)
    if (result === undefined) return undefined
    const instance = yield* (yield* ArchiveWorkflow).status(result.id)
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    return {
      result,
      instance,
      now,
      inProgress: yield* isInProgress(result, instance, now),
    }
  })

// The last run, for the admin page: undefined before any run.
export const lastRunRead = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) => ({
  kinds: [importedKind(source)],
  statements: [lastRunStatement(source)],
  read: ([rows = []]: ReadonlyArray<Rows>) =>
    Effect.gen(function* () {
      const latest = yield* judgeLatest(source, rows)
      if (latest === undefined) return undefined
      return yield* viewRun(latest.result, latest.instance, latest.now)
    }),
})

// Rows read at a time while looking for the newest run `accept` takes.
const PAGE_ROWS = 20

const triggerPage = (kind: RunKind, trigger: string, offset: number) =>
  triggerRunsStatement(kind, trigger, { offset, limit: PAGE_ROWS })

// The newest run of `where.trigger` that `where.accept` takes, however old:
// undefined when none does. It reads the trigger's rows newest first, a page
// at a time, and stops at the first taken: the first page rides in the
// page's batch, and a later one, which only a trigger whose newest
// PAGE_ROWS runs are all passed over needs, has a batch of its own. A record
// that no longer decodes is passed over.
export const latestRunWhereRead = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  where: LatestWhere<Trigger, RunRecord>
) => ({
  kinds: [importedKind(source)],
  statements: [triggerPage(source, where.trigger, 0)],
  read: ([first = []]: ReadonlyArray<Rows>) =>
    Effect.gen(function* () {
      let rows = first
      for (let offset = 0; ; offset += PAGE_ROWS) {
        const taken = (yield* decodeRuns(source.result, rows)).find(
          where.accept
        )
        if (taken !== undefined) return taken
        if (rows.length < PAGE_ROWS) return undefined
        // The first page's batch imported the kind.
        ;[rows = []] = yield* (yield* ArchiveDb).batch([
          triggerPage(source, where.trigger, offset + PAGE_ROWS),
        ])
      }
    }),
})

// Claims the start of `running`'s run by inserting its row as the one the
// kind's last start claimed, unless the run that holds the claim is in
// progress or `running`'s id ran before. Of two starts that judged the same
// holder, the unique index lets one insert; the other judges again against
// the winner.
// Decision: the latest run row is the one claim on a run
// (apps/dashboard/docs/adr/0127-the-latest-run-row-is-the-one-claim-on-a-run.md)
const claim = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  running: RunRecord
): Effect.Effect<
  void,
  | RunInProgress
  | DuplicateRunId
  | ArchiveDbError
  | BucketError
  | WorkflowError
  | Schema.SchemaError,
  ArchiveDb | ArchiveBucket | ArchiveWorkflow
> =>
  Effect.gen(function* () {
    const db = yield* ArchiveDb
    const [taken = [], holder = []] = yield* db.batch([
      runStatement(source, running.id),
      lastRunStatement(source),
    ])
    if (taken.length > 0) return yield* new DuplicateRunId({ id: running.id })
    const latest = yield* judgeLatest(source, holder)
    if (latest?.inProgress)
      return yield* new RunInProgress({ id: latest.result.id })
    const kind = [source.archive, source.runKind] as const
    // Hands the claim on from the holder this start judged ended, in the
    // same transaction as the insert, and only while the id is free, so a
    // refused insert never leaves the kind without a claim.
    const release: ReadonlyArray<{ sql: string; params: Array<string> }> =
      latest === undefined
        ? []
        : [
            {
              sql:
                "UPDATE run SET latest = NULL WHERE archive = ?1 AND " +
                "run_kind = ?2 AND id = ?3 AND latest = 1 AND NOT EXISTS " +
                "(SELECT 1 FROM run WHERE archive = ?1 AND run_kind = ?2 " +
                "AND id = ?4)",
              params: [...kind, latest.result.id, running.id],
            },
          ]
    const results = yield* db.batch([
      ...release,
      {
        sql:
          `INSERT OR IGNORE INTO run (archive, run_kind, ${RUN_COLUMNS}, ` +
          "latest) VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING id",
        params: [...kind, ...runRow(running)],
      },
    ])
    if ((results.at(-1) ?? []).length === 0)
      return yield* claim(source, running)
  })

// Claims the start, with the run's `running` record, then creates the run's
// Workflow instance, kept for RETENTION. The record is in place before
// `create`: after `create`, the run's own steps may already have ended it,
// and writing `running` then would never be undone (apinrdw/kumora#309).
export const startRunOf = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  id: RunId,
  trigger: Trigger
) =>
  Effect.gen(function* () {
    yield* importedRuns(source)
    const record = yield* source.running({
      id,
      trigger,
      startedAt: DateTime.toDateUtc(yield* DateTime.now),
    })
    yield* claim(source, record)
    yield* (yield* ArchiveWorkflow)
      .create({ id, params: { trigger }, retention: RETENTION })
      .pipe(
        // No instance will ever rewrite this record: end it here, so it
        // doesn't hold off runs as in progress.
        Effect.tapError((error) =>
          error._tag === "WorkflowError"
            ? Effect.gen(function* () {
                yield* Effect.logError(
                  "The archive Workflow refused a run",
                  error
                )
                yield* writeRunRecord(source, {
                  ...record,
                  finishedAt: DateTime.formatIso(yield* DateTime.now),
                  outcome: "failed",
                  error: "The Workflow refused to start the run.",
                })
              })
            : Effect.void
        )
      )
  })

// What each cron firing runs: one run per firing, named after its scheduled
// time, unless a run is still in progress.
export const scheduledRun = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger | "cron", Summary, RunRecord>,
  scheduledTime: number
) =>
  Effect.gen(function* () {
    const id = yield* source.runIdAt("cron", scheduledTime)
    yield* startRunOf(source, id, "cron").pipe(
      Effect.catchTags({
        RunInProgress: ({ id: running }) =>
          Effect.logInfo(
            `${source.runName} ${id} skipped: ${running} is in progress`
          ),
        // A second firing for the same scheduled time (a retried invocation).
        DuplicateRunId: () =>
          Effect.logInfo(`${source.runName} ${id} already started`),
      })
    )
  })
