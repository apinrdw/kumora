// One KSEI parse run: `reconcile`, then one `parse:<period end>` step per
// Kepemilikan Efek month to parse, then `summary`. It reads only the KSEI
// archive's bucket and HoldingsDb. The first run parses every held month,
// from the archive's first (FIRST_MONTH, coverage.ts). Spec
// apinrdw/kumora#363, "KSEI parse run".
import type { StepFailed, WorkflowSteps } from "@workspace/server"
import { DateTime, Effect } from "effect"

import type { ArchiveBucket } from "../archive/bucket.ts"
import { type Run, runError } from "../archive/run.ts"
import type { HoldingsDb } from "../holdings/db.ts"
import {
  KSEI_PARSER_VERSION,
  parsedKseiMonths,
  parseKseiMonth,
} from "../holdings/ksei.ts"
import {
  type MonthSource,
  type Parses,
  parseMonths,
} from "../holdings/parse-steps.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import {
  KseiParseRunResult,
  type KseiParseTrigger,
  runningKseiParseResult,
} from "./parse-run-result.ts"
import { putKseiParseRunRecord } from "./parse-runs.ts"

type KseiParseRun = Run<KseiParseTrigger>

const KIND = "securities-holdings"

const kseiMonths: MonthSource = {
  prefix: kindPrefix(KIND),
  reportKey: (periodEnd, sha256) => reportKey(KIND, periodEnd, sha256),
  parsed: parsedKseiMonths,
  parserVersion: KSEI_PARSER_VERSION,
  parse: parseKseiMonth,
}

const finishedResult = Effect.fnUntraced(function* (run: KseiParseRun) {
  return {
    ...(yield* runningKseiParseResult(run)),
    finishedAt: DateTime.formatIso(yield* DateTime.now),
  }
})

const summary = Effect.fnUntraced(function* (
  run: KseiParseRun,
  { monthsParsed, parseFailures }: Parses
) {
  const result = KseiParseRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: parseFailures.length === 0 ? "complete" : "partial",
    monthsParsed,
    parseFailures,
  })
  yield* putKseiParseRunRecord(result)
  return result
})

// `reconcile` failed, so nothing was parsed: the run is failed with its
// message.
const recordReconcileFailure = Effect.fnUntraced(function* (
  run: KseiParseRun,
  error: string
) {
  const result = KseiParseRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    error: yield* runError(error),
  })
  yield* putKseiParseRunRecord(result)
  return result
})

export const kseiParseRun = Effect.fn("kseiParseRun")(function* (
  steps: WorkflowSteps<ArchiveBucket | HoldingsDb>,
  run: KseiParseRun
): Effect.fn.Return<KseiParseRunResult, StepFailed> {
  const parses = yield* parseMonths(steps, kseiMonths).pipe(
    // The run still fails with `reconcile`'s message, which the Workflow
    // keeps as the instance's error.
    Effect.tapError(({ message }) =>
      steps
        .do("failed", recordReconcileFailure(run, message))
        .pipe(Effect.ignore({ log: "Warn" }))
    )
  )
  return yield* steps.do("summary", summary(run, parses))
})
