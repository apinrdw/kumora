// The KSEI archive's runs on the shared run machinery (src/server/archive/):
// its run store, starts, last run and recent runs. Spec apinrdw/kumora#327,
// "Starting a run".
import { Effect } from "effect"

import { listRecentRuns } from "../archive/history.ts"
import type { ArchiveRunId, ArchiveSource } from "../archive/run.ts"
import {
  readLastRun,
  readLatestRunWhere,
  scheduledRun,
  startArchiveRun,
  writeRunRecord,
} from "../archive/runs.ts"
import {
  KseiRunMetadata,
  KseiRunResult,
  type KseiRunSummary,
  KseiTrigger,
  kseiRunIdAt,
  runningKseiResult,
} from "./run-result.ts"

const KSEI_RUNS = {
  runName: "KSEI archive run",
  triggers: KseiTrigger.literals,
  runIdAt: kseiRunIdAt,
  result: KseiRunResult,
  metadata: KseiRunMetadata,
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
export const lastKseiDeepRun = readLatestRunWhere(
  KSEI_RUNS,
  "deep",
  (run) => run.deep !== null
)

export const startKseiRun = (id: ArchiveRunId, trigger: KseiTrigger) =>
  startArchiveRun(KSEI_RUNS, id, trigger)

// What each cron firing runs (`runKseiCron`, cron.ts): one run a day, named
// after its scheduled date (UTC), unless a run is still in progress.
export const scheduledKseiRun = Effect.fn("scheduledKseiRun")(function* (
  scheduledTime: number
) {
  yield* scheduledRun(KSEI_RUNS, scheduledTime)
})
