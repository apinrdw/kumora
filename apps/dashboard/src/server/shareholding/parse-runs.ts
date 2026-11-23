// What each parse cron firing runs (cron.ts): a classification parse run,
// an investor-type parse run and an above-1% parse run, one a day of each,
// named after its scheduled date (UTC), unless one of that kind is still in
// progress.
// One cron starts all three kinds, not a cron each, and each kind
// starts whether the others did or not: they read only R2 and HoldingsDb and
// write different tables, so none waits on another. See apinrdw/kumora#397
// and #473.
import { Effect, Result } from "effect"

import { above1ParseRuns } from "./above-1-parse.ts"
import { classificationParseRuns } from "./classification-parse.ts"
import { investorTypeParseRuns } from "./investor-type-parse.ts"

export const scheduledParseRuns = Effect.fnUntraced(function* (
  scheduledTime: number
) {
  const started = yield* Effect.all(
    [
      classificationParseRuns.scheduled(scheduledTime),
      investorTypeParseRuns.scheduled(scheduledTime),
      above1ParseRuns.scheduled(scheduledTime),
    ],
    { concurrency: "unbounded", mode: "result" }
  )
  for (const result of started)
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
})
