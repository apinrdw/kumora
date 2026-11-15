// A KSEI parse run's result: written to parse-runs/<id>.json while it runs
// and when it ends, and returned as the Workflow instance's output. The KSEI
// admin page's Last parse run card reads it back with this Schema.
import { DateTime, Effect, Schema, Struct } from "effect"

import {
  ParseFailure,
  type Run,
  RunId,
  type RunParams,
  RunOutcome,
} from "../archive/run.ts"

export const KseiParseTrigger = Schema.Literals(["cron", "admin"])
export type KseiParseTrigger = typeof KseiParseTrigger.Type

// What `create` passes the Workflow (KSEI_PARSE in alchemy.run.ts).
export type KseiParseParams = RunParams<KseiParseTrigger>

export const KseiParseRunResult = Schema.Struct({
  id: RunId,
  trigger: KseiParseTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // Period ends parsed into parsed holdings.
  monthsParsed: Schema.Number,
  // Period ends that failed to parse; any makes the run partial.
  parseFailures: Schema.Array(ParseFailure),
  // At most MAX_RUN_ERROR_LENGTH characters.
  error: Schema.NullOr(Schema.String),
})
export type KseiParseRunResult = typeof KseiParseRunResult.Type

const KseiParseRunSummary = KseiParseRunResult.mapFields(
  Struct.pick(["id", "trigger", "startedAt", "outcome", "monthsParsed"])
)
export type KseiParseRunSummary = typeof KseiParseRunSummary.Type

// The custom metadata of parse-runs/<id>.json: its summary.
export const KseiParseRunMetadata = Schema.Struct({
  run: Schema.fromJsonString(KseiParseRunSummary),
})

export const runningKseiParseResult = Effect.fnUntraced(function* (
  run: Run<KseiParseTrigger>
) {
  return KseiParseRunResult.make({
    id: run.id,
    trigger: run.trigger,
    startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    finishedAt: null,
    outcome: "running",
    monthsParsed: 0,
    parseFailures: [],
    error: null,
  })
})
