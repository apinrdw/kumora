// The disclosure archive's runs on the shared run machinery
// (src/server/archive/): its runs in ArchiveDb, starts, and the last run and
// recent runs its admin page reads in one ArchiveDb batch. Its bucket never
// held run records, so the cutover import finds none and only marks the
// kind imported.
import type { DateTime } from "effect"

import { recentRunsRead } from "../archive/history.ts"
import {
  type ArchiveSource,
  dailyRunIdAt,
  type RunId,
  RUNS_PREFIX,
} from "../archive/run.ts"
import { lastRunRead, startRunOf } from "../archive/runs.ts"
import { writeRunRow } from "../archive/run-rows.ts"
import {
  DisclosureRunResult,
  DisclosureRunSummary,
  DisclosureTrigger,
  runningDisclosureResult,
} from "./run-result.ts"

const DISCLOSURE_RUNS = {
  runName: "Disclosure run",
  archive: "disclosure",
  runKind: "archive",
  runsPrefix: RUNS_PREFIX,
  triggers: DisclosureTrigger.literals,
  runIdAt: dailyRunIdAt,
  result: DisclosureRunResult,
  summary: DisclosureRunSummary,
  readersPastRetention: {},
  running: runningDisclosureResult,
} satisfies ArchiveSource<
  DisclosureTrigger,
  DisclosureRunSummary,
  DisclosureRunResult
>

export const writeDisclosureRun = (result: DisclosureRunResult) =>
  writeRunRow(DISCLOSURE_RUNS, result)

// The last run, for the admin page: undefined before any run.
export const lastDisclosureRun = lastRunRead(DISCLOSURE_RUNS)

// The runs started in the 30 days to `now`, newest first.
export const recentDisclosureRuns = (now: DateTime.Utc) =>
  recentRunsRead(DISCLOSURE_RUNS, now)

export const startDisclosureRun = (id: RunId, trigger: DisclosureTrigger) =>
  startRunOf(DISCLOSURE_RUNS, id, trigger)
