// A disclosure run's result: written to its ArchiveDb row while it runs and
// when it ends, and returned as the Workflow instance's output. The admin
// page reads it back with this Schema.
import { WibDate } from "@workspace/relay"
import { DateTime, Effect, Schema, Struct } from "effect"

import { type Run, RunId, type RunParams, RunOutcome } from "../archive/run.ts"
import { DisclosureKey } from "./key.ts"

export const DisclosureTrigger = Schema.Literals(["cron", "admin"])
export type DisclosureTrigger = typeof DisclosureTrigger.Type

// The id of a run `trigger` starts at `epochMs`: `cron-<YYYY-MM-DDTHHMM>`
// from the cron's scheduled time, one per 15-minute firing (a daily id would
// name every firing of a day the same), or `admin-<epoch ms>`. A Workflow
// instance id takes no colon. Ids of one trigger sort as their starts do.
export const disclosureRunIdAt = Effect.fnUntraced(function* (
  trigger: DisclosureTrigger,
  epochMs: number
) {
  if (trigger === "admin") return RunId.make(`admin-${epochMs}`)
  const at = DateTime.makeUnsafe(epochMs)
  const { hour, minute } = DateTime.toPartsUtc(at)
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  return RunId.make(
    `cron-${DateTime.formatIsoDate(at)}T${twoDigits(hour)}${twoDigits(minute)}`
  )
})

// What `create` passes the Workflow (DISCLOSURE_ARCHIVE in alchemy.run.ts).
export type DisclosureParams = RunParams<DisclosureTrigger>

// An attachment the run couldn't store; the next run tries it again.
const NotStoredAttachment = Schema.Struct({
  disclosure: DisclosureKey,
  path: Schema.String,
  // At most MAX_RUN_ERROR_LENGTH characters.
  message: Schema.String,
})
export type NotStoredAttachment = typeof NotStoredAttachment.Type

// A day older than the recent ones whose listing couldn't be read: the run
// went on without it, and the next run lists it again.
// Decision: each disclosure run backfills the oldest incomplete days with its leftover budget
// (apps/dashboard/docs/adr/0138-disclosure-runs-backfill-the-oldest-incomplete-days.md)
const UnlistedDay = Schema.Struct({
  day: WibDate,
  // At most MAX_RUN_ERROR_LENGTH characters.
  message: Schema.String,
})
export type UnlistedDay = typeof UnlistedDay.Type

export const DisclosureRunResult = Schema.Struct({
  id: RunId,
  trigger: DisclosureTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // The disclosure days listed, newest first.
  days: Schema.Array(WibDate),
  // The older disclosure days it took up, oldest first: listed, or resumed
  // where an earlier run's budget ran out.
  backfillDays: Schema.Array(WibDate),
  // The older days it couldn't list, at most MAX_BACKFILL_DAYS, oldest
  // first; none is among backfillDays.
  unlistedDays: Schema.Array(UnlistedDay),
  // Disclosure versions the archive didn't hold, stored.
  versionsAdded: Schema.Number,
  // Listing entries it skipped: a reply with no disclosure key, or an
  // attachment with no path (ADR 0140).
  entriesSkipped: Schema.Number,
  // Why the first MAX_NOT_STORED_SHOWN of them were skipped, each at most
  // MAX_RUN_ERROR_LENGTH characters.
  skipped: Schema.Array(Schema.String),
  // Attachments stored.
  attachmentsStored: Schema.Number,
  // Attachments of its days and backfill days that wait for a later run
  // once this one ends: those it couldn't store, and those past its budget.
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
    backfillDays: [],
    unlistedDays: [],
    versionsAdded: 0,
    entriesSkipped: 0,
    skipped: [],
    attachmentsStored: 0,
    attachmentsWaiting: 0,
    notStored: [],
    error: null,
  })
})
