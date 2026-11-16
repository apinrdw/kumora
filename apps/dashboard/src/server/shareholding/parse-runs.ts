// What each parse cron firing runs (cron.ts): a classification parse run
// and an investor-type parse run, one a day of each, named after its
// scheduled date (UTC), unless one of that kind is still in progress.
// Decision: one cron starts both kinds, not a cron each, and each kind
// starts whether the other did or not: they read only R2 and HoldingsDb and
// write different tables, so neither waits on the other. See
// apinrdw/kumora#397.
import { Effect, Result } from "effect"

import { classificationParseRuns } from "./classification-parse.ts"
import { investorTypeParseRuns } from "./investor-type-parse.ts"

export const scheduledParseRuns = Effect.fnUntraced(function* (
  scheduledTime: number
) {
  const started = yield* Effect.all(
    [
      classificationParseRuns.scheduled(scheduledTime),
      investorTypeParseRuns.scheduled(scheduledTime),
    ],
    { concurrency: "unbounded", mode: "result" }
  )
  for (const result of started)
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
})
