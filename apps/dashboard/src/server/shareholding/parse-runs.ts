// What each parse cron firing runs (cron.ts): a classification parse run,
// an investor-type parse run, an above-1% parse run and an above-5% parse
// run, one a day of each, named after its scheduled date (UTC), unless one
// of that kind is still in progress.
// One cron starts all four kinds, not a cron each, and each kind
// starts whether the others did or not: they read only R2 and HoldingsDb and
// write different tables, so none waits on another. The above-5% parse run
// reads the investor-type holdings' listed shares as they stand when it
// parses a day. See apinrdw/kumora#397, #473 and #673.
import { Effect, Result } from "effect"

import { above1ParseRuns } from "./above-1-parse.ts"
import { above5ParseRuns } from "./above-5-parse.ts"
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
      above5ParseRuns.scheduled(scheduledTime),
    ],
    { concurrency: "unbounded", mode: "result" }
  )
  for (const result of started)
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
})
