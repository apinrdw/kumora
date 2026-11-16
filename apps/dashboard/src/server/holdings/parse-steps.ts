// The steps that parse an archive's months into parsed holdings: `reconcile`
// picks the months to parse (months-to-parse.ts), then one `parse:<date>`
// step per month. Every parse run (parse-runs.ts) runs them: the
// classification parse run on classification reports, the investor-type
// parse run on holdings by investor type reports, the KSEI parse run on Securities
// holdings reports.
import {
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { ParseFailure, runError } from "../archive/run.ts"
import type { HoldingsDb, HoldingsDbError } from "./db.ts"
import { newestUnparsed, type ParsedMonth } from "./months-to-parse.ts"

// A file the parser rejects, with why.
interface Unreadable {
  readonly _tag: `${string}Unreadable`
  readonly message: string
}

// One archive's months, as the steps read and parse them.
export interface MonthSource {
  // Every archived version's record of the report kind sits under it.
  readonly prefix: Effect.Effect<string>
  // Where a month's version is archived.
  readonly reportKey: (date: string, sha256: string) => Effect.Effect<string>
  // The version each parsed month came from.
  readonly parsed: Effect.Effect<
    ReadonlyMap<string, ParsedMonth>,
    HoldingsDbError,
    HoldingsDb
  >
  readonly parserVersion: number
  // Replaces the month's parsed holdings with the version's; the number of
  // stocks parsed.
  readonly parse: (
    date: string,
    sha256: string,
    bytes: Uint8Array,
    parsedAt: string
  ) => Effect.Effect<number, HoldingsDbError | Unreadable, HoldingsDb>
}

// What the steps parsed.
export interface Parses {
  readonly monthsParsed: number
  readonly parseFailures: ReadonlyArray<typeof ParseFailure.Type>
}

// A month to parse: its date and the SHA-256 of its newest version.
const MonthToParse = Schema.Struct({
  date: Schema.String,
  sha256: Schema.String,
})
type MonthToParse = typeof MonthToParse.Type

const reconcile = Effect.fnUntraced(function* (source: MonthSource) {
  const months = yield* newestUnparsed(
    yield* source.prefix,
    yield* source.parsed,
    source.parserVersion
  )
  return months.map((month) => MonthToParse.make(month))
})

// Parses one month's archived version. A file the parser rejects fails
// without retries, with why as its message: its bytes won't change.
const parseMonth = Effect.fnUntraced(function* (
  source: MonthSource,
  { date, sha256 }: MonthToParse
) {
  const key = yield* source.reportKey(date, sha256)
  const bytes = yield* (yield* ArchiveBucket).getBytes(key)
  if (bytes === undefined)
    return yield* new NonRetryable({ message: `The archive has no ${key}` })
  return yield* source
    .parse(date, sha256, bytes, DateTime.formatIso(yield* DateTime.now))
    .pipe(
      Effect.catchIf(
        (error): error is Unreadable => error._tag !== "HoldingsDbError",
        ({ message }) => Effect.fail(new NonRetryable({ message }))
      )
    )
})

// `reconcile`, then a `parse:` step per month it picked. Fails only when
// `reconcile` does.
// Decision: a month that fails to parse doesn't stop the run; its parsed
// holdings stay as they were, the run ends partial, and the next run's
// reconcile picks the month again.
export const parseMonths = Effect.fnUntraced(function* (
  steps: WorkflowSteps<ArchiveBucket | HoldingsDb>,
  source: MonthSource
): Effect.fn.Return<Parses, StepFailed> {
  const months = yield* steps.do("reconcile", reconcile(source))
  const parsed = yield* Effect.forEach(months, (month) =>
    steps.do(`parse:${month.date}`, parseMonth(source, month)).pipe(
      Effect.mapError(({ message }) => ({ date: month.date, message })),
      Effect.result
    )
  )
  return {
    monthsParsed: parsed.filter(Result.isSuccess).length,
    parseFailures: yield* Effect.forEach(
      parsed.filter(Result.isFailure),
      ({ failure: { date, message } }) =>
        Effect.map(runError(message), (reason) =>
          ParseFailure.make({ date, message: reason })
        )
    ),
  }
})
