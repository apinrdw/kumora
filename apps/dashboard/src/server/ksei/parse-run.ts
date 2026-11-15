// One KSEI parse run: `reconcile`, then one `parse:<period end>` step per
// Kepemilikan Efek month to parse, then `summary`. It reads only the KSEI
// archive's bucket and HoldingsDb. The first run parses every held month,
// from the archive's first (FIRST_MONTH, coverage.ts). Spec
// apinrdw/kumora#363, "KSEI parse run".
import {
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { type Run, runError } from "../archive/run.ts"
import type { HoldingsDb } from "../holdings/db.ts"
import {
  KSEI_PARSER_VERSION,
  parsedKseiMonths,
  parseKseiMonth,
} from "../holdings/ksei.ts"
import { newestUnparsed } from "../holdings/months-to-parse.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import {
  KseiParseRunResult,
  type KseiParseTrigger,
  runningKseiParseResult,
} from "./parse-run-result.ts"
import { putKseiParseRunRecord } from "./parse-runs.ts"

type KseiParseRun = Run<KseiParseTrigger>

type StepServices = ArchiveBucket | HoldingsDb

const KIND = "securities-holdings"

// A month to parse: its period end and the SHA-256 of its newest version.
const MonthToParse = Schema.Struct({
  periodEnd: Schema.String,
  sha256: Schema.String,
})
type MonthToParse = typeof MonthToParse.Type

const reconcile = Effect.gen(function* () {
  const months = yield* newestUnparsed(
    yield* kindPrefix(KIND),
    yield* parsedKseiMonths,
    KSEI_PARSER_VERSION
  )
  return months.map(({ date, sha256 }) =>
    MonthToParse.make({ periodEnd: date, sha256 })
  )
})

// Parses one month's archived version into parsed holdings. A file the
// parser rejects fails without retries: its bytes won't change.
const parseMonth = Effect.fnUntraced(function* ({
  periodEnd,
  sha256,
}: MonthToParse) {
  const key = yield* reportKey(KIND, periodEnd, sha256)
  const bytes = yield* (yield* ArchiveBucket).getBytes(key)
  if (bytes === undefined)
    return yield* new NonRetryable({ message: `The archive has no ${key}` })
  return yield* parseKseiMonth(
    periodEnd,
    sha256,
    bytes,
    DateTime.formatIso(yield* DateTime.now)
  ).pipe(
    Effect.catchTag("KseiUnreadable", ({ message }) =>
      Effect.fail(new NonRetryable({ message: `${key}: ${message}` }))
    )
  )
})

const finishedResult = Effect.fnUntraced(function* (run: KseiParseRun) {
  return {
    ...(yield* runningKseiParseResult(run)),
    finishedAt: DateTime.formatIso(yield* DateTime.now),
  }
})

const summary = Effect.fnUntraced(function* (
  run: KseiParseRun,
  monthsParsed: number,
  parseFailures: ReadonlyArray<{ periodEnd: string; message: string }>
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
  steps: WorkflowSteps<StepServices>,
  run: KseiParseRun
): Effect.fn.Return<KseiParseRunResult, StepFailed> {
  const months = yield* steps.do("reconcile", reconcile).pipe(
    // The run still fails with `reconcile`'s message, which the Workflow
    // keeps as the instance's error.
    Effect.tapError(({ message }) =>
      steps
        .do("failed", recordReconcileFailure(run, message))
        .pipe(Effect.ignore({ log: "Warn" }))
    )
  )
  // Decision: a month that fails to parse doesn't stop the run; its parsed
  // holdings stay as they were, the run ends partial, and the next run's
  // reconcile picks the month again.
  const parsed = yield* Effect.forEach(months, (month) =>
    steps.do(`parse:${month.periodEnd}`, parseMonth(month)).pipe(
      Effect.mapError(({ message }) => ({
        periodEnd: month.periodEnd,
        message,
      })),
      Effect.result
    )
  )
  const parseFailures = yield* Effect.forEach(
    parsed.filter(Result.isFailure),
    ({ failure }) =>
      Effect.map(runError(failure.message), (message) => ({
        periodEnd: failure.periodEnd,
        message,
      }))
  )
  return yield* steps.do(
    "summary",
    summary(run, parsed.filter(Result.isSuccess).length, parseFailures)
  )
})
