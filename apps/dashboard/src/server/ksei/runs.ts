// The KSEI archive's runs on the shared run machinery (src/server/archive/):
// its runs in ArchiveDb, starts, last run and recent runs. Spec apinrdw/kumora#327,
// "Starting a run".
import { Effect } from "effect"

import { listRecentRuns } from "../archive/history.ts"
import {
  type ArchiveSource,
  dailyRunIdAt,
  type LatestWhere,
  type RunId,
  RUNS_PREFIX,
} from "../archive/run.ts"
import {
  readLastRun,
  readLatestRunWhere,
  scheduledRun,
  startRunOf,
  writeRunRecord,
} from "../archive/runs.ts"
import {
  KseiRunResult,
  KseiRunSummary,
  KseiTrigger,
  runningKseiResult,
} from "./run-result.ts"

// The latest deep run that has ended with its finds.
const DEEP_RUN = {
  trigger: "deep",
  accept: (run) => run.deep !== null,
} satisfies LatestWhere<KseiTrigger, KseiRunResult>

const KSEI_RUNS = {
  runName: "KSEI archive run",
  archive: "ksei",
  runKind: "archive",
  runsPrefix: RUNS_PREFIX,
  triggers: KseiTrigger.literals,
  runIdAt: dailyRunIdAt,
  result: KseiRunResult,
  summary: KseiRunSummary,
  kept: [DEEP_RUN],
  running: runningKseiResult,
} satisfies ArchiveSource<KseiTrigger, KseiRunSummary, KseiRunResult>

export const putKseiRunRecord = (result: KseiRunResult) =>
  writeRunRecord(KSEI_RUNS, result)

// The last run, for the admin page: undefined before any run.
export const lastKseiRun = readLastRun(KSEI_RUNS)

// The runs started in the past 30 days, newest first.
export const recentKseiRuns = listRecentRuns(KSEI_RUNS)

// The latest deep run that has ended with its finds, however old: the months
// it found nothing for are the coverage grid's "not found". Undefined before
// any.
export const lastKseiDeepRun = readLatestRunWhere(KSEI_RUNS, DEEP_RUN)

export const startKseiRun = (id: RunId, trigger: KseiTrigger) =>
  startRunOf(KSEI_RUNS, id, trigger)

// What each cron firing runs (`runKseiCron`, cron.ts): one run a day, named
// after its scheduled date (UTC), unless a run is still in progress.
export const scheduledKseiRun = Effect.fn("scheduledKseiRun")(function* (
  scheduledTime: number
) {
  yield* scheduledRun(KSEI_RUNS, scheduledTime)
})
