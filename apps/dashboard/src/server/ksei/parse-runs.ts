// The KSEI parse run's runs on the shared run machinery (src/server/archive/):
// its run store under parse-runs/ in the KSEI archive's bucket, its starts
// and its last run. Its Workflow is KseiParseWorkflow, which these provide
// to the machinery as its ArchiveWorkflow, so a layer can hold both the KSEI
// archive run's Workflow and this one.
import { Context, Effect } from "effect"

import type { RunId, ArchiveSource } from "../archive/run.ts"
import {
  readLastRun,
  scheduledRun,
  startRunOf,
  writeRunRecord,
} from "../archive/runs.ts"
import { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  KseiParseRunMetadata,
  KseiParseRunResult,
  type KseiParseRunSummary,
  KseiParseTrigger,
  runningKseiParseResult,
} from "./parse-run-result.ts"
import { kseiRunIdAt } from "./run-result.ts"

export class KseiParseWorkflow extends Context.Service<
  KseiParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/ksei/KseiParseWorkflow") {}

const onParseWorkflow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideServiceEffect(
    effect,
    ArchiveWorkflow,
    Effect.service(KseiParseWorkflow)
  )

const KSEI_PARSE_RUNS = {
  runName: "KSEI parse run",
  runsPrefix: "parse-runs/",
  triggers: KseiParseTrigger.literals,
  // `cron-<YYYY-MM-DD>` or `admin-<epoch ms>`, as the KSEI archive run's.
  runIdAt: kseiRunIdAt,
  result: KseiParseRunResult,
  metadata: KseiParseRunMetadata,
  running: runningKseiParseResult,
} satisfies ArchiveSource<
  KseiParseTrigger,
  KseiParseRunSummary,
  KseiParseRunResult
>

export const putKseiParseRunRecord = (result: KseiParseRunResult) =>
  writeRunRecord(KSEI_PARSE_RUNS, result)

// The last parse run, for the admin page: undefined before any run.
export const lastKseiParseRun = onParseWorkflow(readLastRun(KSEI_PARSE_RUNS))

export const startKseiParseRun = (id: RunId, trigger: KseiParseTrigger) =>
  onParseWorkflow(startRunOf(KSEI_PARSE_RUNS, id, trigger))

// What each cron firing runs (`runKseiParseCron`, cron.ts): one run a day,
// named after its scheduled date (UTC), unless a run is still in progress.
export const scheduledKseiParseRun = Effect.fn("scheduledKseiParseRun")(
  function* (scheduledTime: number) {
    yield* onParseWorkflow(scheduledRun(KSEI_PARSE_RUNS, scheduledTime))
  }
)
