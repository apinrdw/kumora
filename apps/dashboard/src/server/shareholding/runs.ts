// The shareholding archive's runs on the shared run machinery
// (src/server/archive/): its runs in ArchiveDb, starts, last run and recent runs.
// Spec apinrdw/kumora#303, "Starting a run".
import { type DateTime, Effect } from "effect"

import { recentRunsRead } from "../archive/history.ts"
import { type ArchiveSource, type RunId, RUNS_PREFIX } from "../archive/run.ts"
import {
  lastRunRead,
  scheduledRun,
  startRunOf,
  writeRunRecord,
} from "../archive/runs.ts"
import {
  ArchiveRunResult,
  ArchiveTrigger,
  runIdAt,
  runningResult,
  RunSummary,
} from "./run-result.ts"

const SHAREHOLDING_RUNS = {
  runName: "Archive run",
  archive: "shareholding",
  runKind: "archive",
  runsPrefix: RUNS_PREFIX,
  triggers: ArchiveTrigger.literals,
  runIdAt,
  result: ArchiveRunResult,
  summary: RunSummary,
  kept: [],
  running: runningResult,
} satisfies ArchiveSource<ArchiveTrigger, RunSummary, ArchiveRunResult>

export const putRunRecord = (result: ArchiveRunResult) =>
  writeRunRecord(SHAREHOLDING_RUNS, result)

// The last run, for the admin page: undefined before any run.
export const lastRun = lastRunRead(SHAREHOLDING_RUNS)

// The runs started in the 30 days to `now`, newest first.
export const recentRuns = (now: DateTime.Utc) =>
  recentRunsRead(SHAREHOLDING_RUNS, now)

export const startRun = (id: RunId, trigger: ArchiveTrigger) =>
  startRunOf(SHAREHOLDING_RUNS, id, trigger)

// What each cron firing runs (`runArchiveCron`, cron.ts): one run per firing,
// named after its scheduled hour (UTC), unless a run is still in progress.
export const scheduledArchiveRun = Effect.fn("scheduledArchiveRun")(function* (
  scheduledTime: number
) {
  yield* scheduledRun(SHAREHOLDING_RUNS, scheduledTime)
})
