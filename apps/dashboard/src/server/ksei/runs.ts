// The KSEI archive's runs on the shared run machinery (src/server/archive/):
// its runs in ArchiveDb, starts, and the last run, recent runs and latest
// deep run its admin page reads in one ArchiveDb batch. Spec
// apinrdw/kumora#327, "Starting a run".
import { type DateTime, Effect } from "effect"

import { recentRunsRead } from "../archive/history.ts"
import {
  type ArchiveSource,
  dailyRunIdAt,
  type RunId,
  RUNS_PREFIX,
} from "../archive/run.ts"
import {
  lastRunRead,
  latestRunWhereRead,
  scheduledRun,
  startRunOf,
} from "../archive/runs.ts"
import { writeRunRow } from "../archive/run-rows.ts"
import {
  KseiRunResult,
  KseiRunSummary,
  KseiTrigger,
  runningKseiResult,
} from "./run-result.ts"

const KSEI_RUNS = {
  runName: "KSEI archive run",
  archive: "ksei",
  runKind: "archive",
  runsPrefix: RUNS_PREFIX,
  triggers: KseiTrigger.literals,
  runIdAt: dailyRunIdAt,
  result: KseiRunResult,
  summary: KseiRunSummary,
  // The latest deep run that has ended with its finds.
  readersPastRetention: { deep: (run) => run.deep !== null },
  running: runningKseiResult,
} satisfies ArchiveSource<KseiTrigger, KseiRunSummary, KseiRunResult>

export const writeKseiRun = (result: KseiRunResult) =>
  writeRunRow(KSEI_RUNS, result)

// The last run, for the admin page: undefined before any run.
export const lastKseiRun = lastRunRead(KSEI_RUNS)

// The runs started in the 30 days to `now`, newest first.
export const recentKseiRuns = (now: DateTime.Utc) =>
  recentRunsRead(KSEI_RUNS, now)

// The latest deep run that has ended with its finds, however old: the months
// it found nothing for are the coverage grid's "not found". Undefined before
// any.
export const lastKseiDeepRun = latestRunWhereRead(KSEI_RUNS, "deep")

export const startKseiRun = (id: RunId, trigger: KseiTrigger) =>
  startRunOf(KSEI_RUNS, id, trigger)

// What each cron firing runs (`runKseiCron`, cron.ts): one run a day, named
// after its scheduled date (UTC), unless a run is still in progress.
export const scheduledKseiRun = Effect.fn("scheduledKseiRun")(function* (
  scheduledTime: number
) {
  yield* scheduledRun(KSEI_RUNS, scheduledTime)
})
