// A disclosure run's result: written to its ArchiveDb row while it runs and
// when it ends, and returned as the Workflow instance's output. The admin
// page reads it back with this Schema.
import { DateTime, Effect, Schema, Struct } from "effect"

import { type Run, RunId, type RunParams, RunOutcome } from "../archive/run.ts"

export const DisclosureTrigger = Schema.Literals(["admin"])
export type DisclosureTrigger = typeof DisclosureTrigger.Type

// What `create` passes the Workflow (DISCLOSURE_ARCHIVE in alchemy.run.ts).
export type DisclosureParams = RunParams<DisclosureTrigger>

// An attachment the run couldn't store; the next run tries it again.
const NotStoredAttachment = Schema.Struct({
  disclosure: Schema.String,
  path: Schema.String,
  // At most MAX_RUN_ERROR_LENGTH characters.
  message: Schema.String,
})
export type NotStoredAttachment = typeof NotStoredAttachment.Type

export const DisclosureRunResult = Schema.Struct({
  id: RunId,
  trigger: DisclosureTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // The disclosure days listed, newest first, YYYY-MM-DD.
  days: Schema.Array(Schema.String),
  // Disclosure versions the archive didn't hold, stored.
  versionsAdded: Schema.Number,
  // Attachments stored.
  attachmentsStored: Schema.Number,
  // Attachments of the listed days that wait for a later run once this one
  // ends: those it couldn't store, and those past its budget.
  attachmentsWaiting: Schema.Number,
  // The first MAX_NOT_STORED_SHOWN of the attachments it couldn't store.
  notStored: Schema.Array(NotStoredAttachment),
  // At most MAX_RUN_ERROR_LENGTH characters.
  error: Schema.NullOr(Schema.String),
})
export type DisclosureRunResult = typeof DisclosureRunResult.Type

// A run as the recent runs table shows it.
export const DisclosureRunSummary = DisclosureRunResult.mapFields(
  Struct.pick([
    "id",
    "trigger",
    "startedAt",
    "outcome",
    "versionsAdded",
    "attachmentsStored",
  ])
)
export type DisclosureRunSummary = typeof DisclosureRunSummary.Type

export const runningDisclosureResult = Effect.fnUntraced(function* (
  run: Run<DisclosureTrigger>
) {
  return DisclosureRunResult.make({
    id: run.id,
    trigger: run.trigger,
    startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    finishedAt: null,
    outcome: "running",
    days: [],
    versionsAdded: 0,
    attachmentsStored: 0,
    attachmentsWaiting: 0,
    notStored: [],
    error: null,
  })
})
