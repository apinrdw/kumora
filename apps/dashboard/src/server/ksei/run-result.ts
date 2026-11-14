// A KSEI archive run's result: written to runs/<id>.json while it runs and
// when it ends, and returned as the Workflow instance's output. The admin
// page reads it back with this Schema (spec apinrdw/kumora#327, "Run result
// shape").
import { DateTime, Effect, Schema, Struct } from "effect"

import { ArchiveRunId, type RunParams, RunOutcome } from "../archive/run.ts"
import { KseiReportKind } from "./kind.ts"

export const KseiTrigger = Schema.Literals(["cron", "admin"])
export type KseiTrigger = typeof KseiTrigger.Type

// What `create` passes the Workflow (KSEI_ARCHIVE in alchemy.run.ts).
export type KseiParams = RunParams<KseiTrigger>

// The id of a run `trigger` starts at `epochMs`: `cron-<YYYY-MM-DD>` from the
// cron's scheduled time (it fires once a day), or `admin-<epoch ms>`. Ids of
// one trigger sort as their starts do.
export const kseiRunIdAt = Effect.fnUntraced(function* (
  trigger: KseiTrigger,
  epochMs: number
) {
  return ArchiveRunId.make(
    trigger === "cron"
      ? `cron-${new Date(epochMs).toISOString().slice(0, 10)}`
      : `admin-${epochMs}`
  )
})

export const ListingFailure = Schema.Struct({
  kind: KseiReportKind,
  message: Schema.String,
})

export const KseiRunResult = Schema.Struct({
  id: ArchiveRunId,
  trigger: KseiTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // Files under a filename the archive didn't hold.
  reportsAdded: Schema.Number,
  // Changed files under a filename it already held.
  newVersions: Schema.Number,
  // Held filenames checked for a changed ETag.
  reportsChecked: Schema.Number,
  // Filenames stored whose MD5 isn't their ETag. They don't make a run
  // partial.
  md5Mismatches: Schema.Array(Schema.String),
  // The kinds whose listing couldn't be read, which the run skipped.
  listingFailures: Schema.Array(ListingFailure),
  // Filenames the run couldn't store; the next run retries them.
  notStored: Schema.Array(Schema.String),
  // At most MAX_RUN_ERROR_LENGTH characters.
  error: Schema.NullOr(Schema.String),
})
export type KseiRunResult = typeof KseiRunResult.Type

// A run as the recent runs table shows it.
const KseiRunSummary = KseiRunResult.mapFields(
  Struct.pick([
    "id",
    "trigger",
    "startedAt",
    "outcome",
    "reportsAdded",
    "newVersions",
  ])
)
export type KseiRunSummary = typeof KseiRunSummary.Type

// The custom metadata of runs/<id>.json: its summary, ~150 bytes of R2's
// 2 KB of custom metadata.
export const KseiRunMetadata = Schema.Struct({
  run: Schema.fromJsonString(KseiRunSummary),
})

export const runningKseiResult = Effect.fnUntraced(function* (run: {
  readonly id: ArchiveRunId
  readonly trigger: KseiTrigger
  readonly startedAt: Date
}) {
  return KseiRunResult.make({
    id: run.id,
    trigger: run.trigger,
    startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    finishedAt: null,
    outcome: "running",
    reportsAdded: 0,
    newVersions: 0,
    reportsChecked: 0,
    md5Mismatches: [],
    listingFailures: [],
    notStored: [],
    error: null,
  })
})
