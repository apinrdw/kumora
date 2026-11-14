// An archive run's result: written to runs/<id>.json while it runs and when
// it ends, and returned as the Workflow instance's output. The admin page
// reads it back with this Schema.
import { Effect, Schema } from "effect"

const ArchiveTrigger = Schema.Literals(["cron", "admin"])
export type ArchiveTrigger = typeof ArchiveTrigger.Type

// What `create` passes the Workflow (SHAREHOLDING_ARCHIVE in alchemy.run.ts).
export interface ArchiveParams {
  readonly trigger: ArchiveTrigger
}

export const ArchiveRunResult = Schema.Struct({
  id: Schema.String,
  trigger: ArchiveTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["running", "complete", "partial", "failed"]),
  // Reports at a URL the archive didn't hold.
  reportsAdded: Schema.Number,
  // Changed files at a URL it already held.
  newVersions: Schema.Number,
  // Held URLs checked for a changed ETag.
  reportsChecked: Schema.Number,
  // URLs the run couldn't store; the next run retries them.
  notStored: Schema.Array(Schema.String),
  // Reports archived under `other`: an unknown description prefix.
  other: Schema.Array(
    Schema.Struct({ sourceUrl: Schema.String, description: Schema.String })
  ),
  error: Schema.NullOr(Schema.String),
})
export type ArchiveRunResult = typeof ArchiveRunResult.Type

// The pointer at runs/latest.json.
export const LatestRun = Schema.Struct({ id: Schema.String })

export const runningResult = Effect.fnUntraced(function* (run: {
  readonly id: string
  readonly trigger: ArchiveTrigger
  readonly startedAt: string
}) {
  return ArchiveRunResult.make({
    ...run,
    finishedAt: null,
    outcome: "running",
    reportsAdded: 0,
    newVersions: 0,
    reportsChecked: 0,
    notStored: [],
    other: [],
    error: null,
  })
})
