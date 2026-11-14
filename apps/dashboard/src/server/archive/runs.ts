// An archive's run store and starting its runs: runs/<id>.json and the
// runs/latest.json pointer, the one-run-at-a-time start from its cron or an
// admin page, and the last run the page shows. Spec apinrdw/kumora#303,
// "Starting a run". Each archive passes its ArchiveSource (run.ts) and
// provides its own ArchiveBucket and ArchiveWorkflow.
import { DateTime, Effect, Option, Schema } from "effect"

import { ArchiveBucket, type BucketError } from "./bucket.ts"
import { RETENTION } from "./retention.ts"
import {
  type RunBase,
  RunId,
  type ArchiveSource,
  LATEST_RUN_KEY,
  LatestRun,
  runKey,
  RUNS_PREFIX,
  type RunSummaryBase,
} from "./run.ts"
import { isInProgress, START_WINDOW_MS, viewRun } from "./run-view.ts"
import {
  ArchiveWorkflow,
  DuplicateRunId,
  type WorkflowError,
} from "./workflow.ts"

// The run runs/latest.json names is still in progress.
class RunInProgress extends Schema.TaggedError<RunInProgress>()(
  "RunInProgress",
  { id: RunId }
) {}

const decodeLatestRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LatestRun)
)

// Writes runs/<id>.json, with its summary as custom metadata.
export const writeRunRecord = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  result: RunRecord
) =>
  Effect.gen(function* () {
    yield* (yield* ArchiveBucket).put(
      yield* runKey(result.id),
      JSON.stringify(result),
      {
        contentType: "application/json",
        customMetadata: Schema.encodeSync(source.metadata)({ run: result }),
      }
    )
  })

// The run runs/latest.json names: its record, its instance's status, and
// the pointer's ETag, which a start that claims it must still find.
const readLatest = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const bucket = yield* ArchiveBucket
    const pointer = yield* bucket.get(LATEST_RUN_KEY)
    if (pointer === undefined) return undefined
    const { id } = yield* decodeLatestRun(pointer.body)
    const record = yield* bucket.get(yield* runKey(id))
    const result =
      record === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(source.result)
          )(record.body)
    const instance = yield* (yield* ArchiveWorkflow).status(id)
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    return {
      id,
      etag: pointer.etag,
      result,
      instance,
      now,
      // With neither a record nor an instance, a start has just claimed the
      // pointer and is still writing them.
      inProgress:
        result === undefined && instance === undefined
          ? now - pointer.uploaded.getTime() < START_WINDOW_MS
          : yield* isInProgress(result, instance, now),
    }
  })

// The last run, for the admin page: undefined before any run.
export const readLastRun = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const latest = yield* readLatest(source)
    if (latest?.result === undefined) return undefined
    return yield* viewRun(latest.result, latest.instance, latest.now)
  })

// The newest record of `trigger`'s runs that `accept` takes, however old:
// undefined when none does. Ids of one trigger sort as their starts do
// (`runIdAt`), so it reads records newest first and stops at the first
// taken. A record that no longer decodes is passed over.
export const readLatestRunWhere = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  trigger: Trigger,
  accept: (run: RunRecord) => boolean
) =>
  Effect.gen(function* () {
    const bucket = yield* ArchiveBucket
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(source.result)
    )
    const keys = (yield* bucket.list(`${RUNS_PREFIX}${trigger}-`))
      .map(({ key }) => key)
      .filter((key) => key.endsWith(".json"))
      .reverse()
    for (const key of keys) {
      const record = yield* bucket.get(key)
      if (record === undefined) continue
      const run = Option.getOrUndefined(decode(record.body))
      if (run !== undefined && accept(run)) return run
    }
    return undefined
  })

// Points runs/latest.json at `id`, unless the run it names is in progress or
// `id` ran before. Only a start writes the pointer: no step of a run does.
// Decision: the pointer is the one claim on starting a run, for the cron and
// Run now alike, written in one conditional R2 write only while its ETag is
// the one this start judged. Of two starts that read the same pointer, one
// claims it and the other judges again against the winner. See
// apinrdw/kumora#309.
const claim = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  id: RunId
): Effect.Effect<
  void,
  | RunInProgress
  | DuplicateRunId
  | BucketError
  | WorkflowError
  | Schema.SchemaError,
  ArchiveBucket | ArchiveWorkflow
> =>
  Effect.gen(function* () {
    const latest = yield* readLatest(source)
    if (latest?.id === id) return yield* new DuplicateRunId({ id })
    if (latest?.inProgress) return yield* new RunInProgress({ id: latest.id })
    const bucket = yield* ArchiveBucket
    // A start claiming the same id claims from this same pointer, so only one
    // gets past the write below.
    if (yield* bucket.exists(yield* runKey(id)))
      return yield* new DuplicateRunId({ id })
    const claimed = yield* bucket.putIfUnchanged(
      LATEST_RUN_KEY,
      JSON.stringify(LatestRun.make({ id })),
      { contentType: "application/json" },
      latest?.etag
    )
    if (!claimed) return yield* claim(source, id)
  })

// Claims the start, then creates the run's Workflow instance, kept for
// RETENTION, with a `running` record.
// Decision: the record is written before `create`: after `create`, the run's
// own steps may already have ended it, and writing `running` then would
// never be undone (apinrdw/kumora#309).
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
    yield* claim(source, id)
    const record = yield* source.running({
      id,
      trigger,
      startedAt: DateTime.toDateUtc(yield* DateTime.now),
    })
    yield* writeRunRecord(source, record)
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
