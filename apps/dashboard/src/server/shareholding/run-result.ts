// An archive run's result: written to runs/<id>.json while it runs and when
// it ends, and returned as the Workflow instance's output. The admin page
// reads it back with this Schema.
import { DateTime, Effect, Schema, Struct } from "effect"

import { type Run, RunId, type RunParams, RunOutcome } from "../archive/run.ts"

export const ArchiveTrigger = Schema.Literals(["cron", "admin"])
export type ArchiveTrigger = typeof ArchiveTrigger.Type

// What `create` passes the Workflow (SHAREHOLDING_ARCHIVE in alchemy.run.ts).
export type ArchiveParams = RunParams<ArchiveTrigger>

// The id of a run `trigger` starts at `epochMs`: `cron-<YYYY-MM-DDTHH>` from
// the cron's scheduled time, or `admin-<epoch ms>`. Ids of one trigger sort
// as their starts do (epoch ms keep 13 digits until 2286).
export const runIdAt = Effect.fnUntraced(function* (
  trigger: ArchiveTrigger,
  epochMs: number
) {
  return RunId.make(
    trigger === "cron"
      ? `cron-${new Date(epochMs).toISOString().slice(0, 13)}`
      : `admin-${epochMs}`
  )
})

export const ArchiveRunResult = Schema.Struct({
  id: RunId,
  trigger: ArchiveTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // Reports at a URL the archive didn't hold.
  reportsAdded: Schema.Number,
  // Changed files at a URL it already held.
  newVersions: Schema.Number,
  // Held URLs checked for a changed ETag.
  reportsChecked: Schema.Number,
  // URLs the run couldn't store; the next run retries them.
  notStored: Schema.Array(Schema.String),
  // Classification months parsed into parsed holdings. Records written
  // before the reconcile existed have none: 0.
  monthsParsed: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  // Reports archived under `other`: an unknown description prefix.
  other: Schema.Array(
    Schema.Struct({ sourceUrl: Schema.String, description: Schema.String })
  ),
  // At most MAX_RUN_ERROR_LENGTH characters.
  error: Schema.NullOr(Schema.String),
})
export type ArchiveRunResult = typeof ArchiveRunResult.Type

// A run as the recent runs table shows it.
export const RunSummary = ArchiveRunResult.mapFields(
  Struct.pick([
    "id",
    "trigger",
    "startedAt",
    "outcome",
    "reportsAdded",
    "newVersions",
  ])
)
export type RunSummary = typeof RunSummary.Type

// The custom metadata of runs/<id>.json (`putRunRecord`): its summary, so
// the recent runs table reads the listing of runs/ and no record, whose
// URLs can take most of a MiB. A summary takes ~150 bytes of R2's 2 KB of
// custom metadata. S3 lowercases metadata names, hence the lowercase name.
export const RunMetadata = Schema.Struct({
  run: Schema.fromJsonString(RunSummary),
})

export const runningResult = Effect.fnUntraced(function* (
  run: Run<ArchiveTrigger>
) {
  return ArchiveRunResult.make({
    id: run.id,
    trigger: run.trigger,
    startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    finishedAt: null,
    outcome: "running",
    reportsAdded: 0,
    newVersions: 0,
    reportsChecked: 0,
    notStored: [],
    monthsParsed: 0,
    other: [],
    error: null,
  })
})
