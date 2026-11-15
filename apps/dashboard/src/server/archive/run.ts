// What every archive's runs share: a run's id and outcome, the fields its
// record always holds, where the records live in the archive's bucket, and
// the ArchiveSource through which an archive describes its own runs to the
// shared run machinery (runs.ts, history.ts).
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
) => ({
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

// Where an archive run's records live. A run that isn't an archive run, such
// as the KSEI parse run, keeps its own under another prefix in the same
// bucket (`ArchiveSource.runsPrefix`).
export const RUNS_PREFIX = "runs/"

// <prefix><id>.json, a run's record.
export const runKey = Effect.fnUntraced(function* (
  id: RunId,
  prefix: string = RUNS_PREFIX
) {
  return `${prefix}${id}.json`
})

// <prefix>latest.json, the pointer at the last run started.
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

// One archive's runs, as the shared run machinery reads and writes them.
// `RunRecord` is its record at runs/<id>.json, `Summary` the part of it the
// record's custom metadata carries.
export interface ArchiveSource<
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
> {
  // How a log line names one of its runs, as "Archive run".
  readonly runName: string
  // Where its run records and latest pointer live in the bucket, as
  // RUNS_PREFIX.
  readonly runsPrefix: string
  // Every trigger that starts its runs.
  readonly triggers: ReadonlyArray<Trigger>
  // The id of the run `trigger` starts at `epochMs`. Ids of one trigger must
  // sort as their starts do: the recent runs list each trigger's ids from 30
  // days ago on (history.ts).
  readonly runIdAt: (trigger: Trigger, epochMs: number) => Effect.Effect<RunId>
  readonly result: Schema.Codec<RunRecord, unknown>
  // The custom metadata of runs/<id>.json: its summary, so the recent runs
  // read the listing of runs/ and no record.
  readonly metadata: Schema.Codec<
    { readonly run: Summary },
    Readonly<Record<string, string>>
  >
  // A run's record from its start until it ends.
  readonly running: (run: Run<Trigger>) => Effect.Effect<RunRecord>
}
