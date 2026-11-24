// A parse run's result, the same for every kind (parse-runs.ts): written to
// <runs prefix><id>.json while it runs and when it ends, and returned as the
// Workflow instance's output. An admin page's last parse run card reads it
// back with this Schema.
import { DateTime, Effect, Schema, Struct } from "effect"

import {
  ParseFailure,
  type Run,
  RunId,
  type RunParams,
  RunOutcome,
} from "../archive/run.ts"

export const ParseTrigger = Schema.Literals(["cron", "admin"])
export type ParseTrigger = typeof ParseTrigger.Type

// What `create` passes a parse run's Workflow (alchemy.run.ts).
export type ParseParams = RunParams<ParseTrigger>

export const ParseRunResult = Schema.Struct({
  id: RunId,
  trigger: ParseTrigger,
  // ISO instants.
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: RunOutcome,
  // Months parsed into parsed holdings.
  monthsParsed: Schema.Number,
  // Months that failed to parse; any makes the run partial.
  parseFailures: Schema.Array(ParseFailure),
  // At most MAX_RUN_ERROR_LENGTH characters.
  error: Schema.NullOr(Schema.String),
})
export type ParseRunResult = typeof ParseRunResult.Type

export const ParseRunSummary = ParseRunResult.mapFields(
  Struct.pick(["id", "trigger", "startedAt", "outcome", "monthsParsed"])
)
export type ParseRunSummary = typeof ParseRunSummary.Type

export const runningParseResult = Effect.fnUntraced(function* (
  run: Run<ParseTrigger>
) {
  return ParseRunResult.make({
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
