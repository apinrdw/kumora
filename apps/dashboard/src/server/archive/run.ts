// What every archive's runs share: a run's id and outcome, the fields its
// record always holds, and the ArchiveSource through which an archive
// describes its own runs to the shared run machinery (runs.ts, history.ts).
// ArchiveDb holds the runs (run-rows.ts). Before it did, each archive's
// bucket held them, where the cutover import (run-import.ts) reads them:
//
//   runs/<run-id>.json                                     one per run
//   runs/latest.json                                       { id } of the last run
import { Effect, Result, Schema } from "effect"

// A run's id, which is also its Workflow instance's: `<trigger>-<when>`, as
// the archive's `runIdAt` names it.
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const RunOutcome = Schema.Literals([
  "running",
  "complete",
  "partial",
  "failed",
])
export type RunOutcome = typeof RunOutcome.Type

// A month a parse run couldn't parse, by its date (a classification
// report's data date, a KSEI report's period end), and why, in at most
// MAX_RUN_ERROR_LENGTH characters. It keeps its earlier parsed holdings, and
// the next run tries it again.
export const ParseFailure = Schema.Struct({
  date: Schema.String,
  message: Schema.String,
})

// The most characters of an error a run record keeps. A failure's message
// can quote what the source sent, which the source decides the size of.
export const MAX_RUN_ERROR_LENGTH = 1000

// `error` as a run record keeps it: cut to MAX_RUN_ERROR_LENGTH characters,
// the last an ellipsis.
export const runError = Effect.fnUntraced(function* (error: string) {
  return error.length > MAX_RUN_ERROR_LENGTH
    ? `${error.slice(0, MAX_RUN_ERROR_LENGTH - 1)}…`
    : error
})

// The id of a run `trigger` starts at `epochMs`, for runs whose cron fires
// once a day (the KSEI archive run, every parse run): `cron-<YYYY-MM-DD>`
// from the cron's scheduled time, or `<trigger>-<epoch ms>`. Ids of one
// trigger sort as their starts do.
export const dailyRunIdAt = Effect.fnUntraced(function* (
  trigger: string,
  epochMs: number
) {
  return RunId.make(
    trigger === "cron"
      ? `cron-${new Date(epochMs).toISOString().slice(0, 10)}`
      : `${trigger}-${epochMs}`
  )
})

// A run as its Workflow starts it: its instance's id and start, and the
// trigger `create` passed.
export interface Run<Trigger extends string = string> {
  readonly id: RunId
  readonly trigger: Trigger
  readonly startedAt: Date
}

// What a run's `report:` steps stored, and what it couldn't: the held files
// whose HEAD failed, which may hide a change, then each failed step's file.
export const storedReports = <A>(
  stored: ReadonlyArray<Result.Result<A, string>>,
  unanswered: ReadonlyArray<string>
) =>
  Effect.succeed({
    archived: stored.filter(Result.isSuccess).map(({ success }) => success),
    notStored: [
      ...unanswered,
      ...stored.filter(Result.isFailure).map(({ failure }) => failure),
    ],
  })

// What `create` passes a run's Workflow.
export interface RunParams<Trigger extends string = string> {
  readonly trigger: Trigger
}

// Every stored file and its records, under reports/<kind>/ (each archive's
// keys.ts).
export const REPORTS_PREFIX = "reports/"

// The slowest a healthy call to an archive's own stores answers: a page of a
// bucket listing, a put, an ArchiveDb batch. The admin pages' slowest such
// call took 1.5 s, a listing of reports/ across an ocean (apinrdw/kumora#657,
// 2026-11-24). A step's timeout adds this for each call it makes in turn.
export const STORE_SLOWEST_ANSWER = "2 seconds"

// The calls in turn a run's `plan` makes to its stores at the largest
// listing: 10 pages of reports/ at MAX_LISTED_OBJECTS (bucket.ts), 3
// ArchiveDb batches to heal the report index from it (23 chunks at that
// size, report-index.test.ts), and one more to write its run's row. The
// claim on the run is its start's, before any step (runs.ts).
export const PLAN_STORE_CALLS = 14

// The calls in turn a `report:` step makes to its stores: whether its file is
// held, the file, its record, and the record's row in the report index.
export const REPORT_STORE_CALLS = 4

// Where an archive run's records lived in R2. A run that isn't an archive
// run, such as the KSEI parse run, kept its own under another prefix in the
// same bucket (`ArchiveSource.runsPrefix`).
export const RUNS_PREFIX = "runs/"

// <prefix><id>.json, a run's record.
export const runKey = Effect.fnUntraced(function* (
  id: RunId,
  prefix: string = RUNS_PREFIX
) {
  return `${prefix}${id}.json`
})

// <prefix>latest.json, the pointer at the last run started, until ArchiveDb
// held the runs.
export const latestRunKey = Effect.fnUntraced(function* (prefix: string) {
  return `${prefix}latest.json`
})

// The pointer at <prefix>latest.json.
export const LatestRun = Schema.Struct({ id: RunId })

// What every archive's run summary holds: the recent runs table's row.
export interface RunSummaryBase {
  readonly id: RunId
  readonly trigger: string
  // An ISO instant.
  readonly startedAt: string
  readonly outcome: RunOutcome
}

// What every archive's run record holds, besides its own counts.
export interface RunBase extends RunSummaryBase {
  // An ISO instant, null while the run runs.
  readonly finishedAt: string | null
  // At most MAX_RUN_ERROR_LENGTH characters.
  readonly error: string | null
}

// Which archive a run is of, as the report index names it
// (report-index.ts): each has its own bucket and run machinery.
export type RunArchive = "ksei" | "shareholding"

// The newest run of `trigger` that `accept` takes, however old, which a
// reader finds (readLatestRunWhere, runs.ts).
export interface LatestWhere<Trigger extends string, RunRecord> {
  readonly trigger: Trigger
  readonly accept: (run: RunRecord) => boolean
}

// One kind of an archive's runs, as the shared run machinery reads and
// writes them. `RunRecord` is its run record, `Summary` the part of it the
// recent runs table shows.
export interface ArchiveSource<
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
> {
  // How a log line names one of its runs, as "Archive run".
  readonly runName: string
  readonly archive: RunArchive
  // Which of the archive's runs, as "archive": one run of each kind is in
  // progress at a time.
  readonly runKind: string
  // Where its run records and latest pointer lived in the bucket, as
  // RUNS_PREFIX, for the cutover import.
  readonly runsPrefix: string
  // Every trigger that starts its runs.
  readonly triggers: ReadonlyArray<Trigger>
  // The id of the run `trigger` starts at `epochMs`. Ids of one trigger must
  // sort as their starts do: the cutover import lists each trigger's ids
  // from 30 days ago on.
  readonly runIdAt: (trigger: Trigger, epochMs: number) => Effect.Effect<RunId>
  readonly result: Schema.Codec<RunRecord, unknown>
  readonly summary: Schema.Codec<Summary, unknown>
  // The runs older than 30 days a reader still finds: the cutover import
  // brings the newest of each along.
  readonly kept: ReadonlyArray<LatestWhere<Trigger, RunRecord>>
  // A run's record from its start until it ends.
  readonly running: (run: Run<Trigger>) => Effect.Effect<RunRecord>
}
