// When the relay streams (spec apinrdw/kumora#138, "Streaming hours" and
// "Auctions"), from the shared IDX schedule.
import { marketMomentAt } from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect } from "effect"

import type { Window } from "./broker.ts"

// Decision: connections open at 08:40 and close at 16:35 WIB on trading days.
// A connection opened mid-auction is unproven, so during pre-opening and
// pre-closing a dropped connection reconnects but none opens fresh. A year
// missing from the schedule streams nothing, so a stale table fails quiet
// rather than relaying a holiday. See apinrdw/kumora#62.
export const windowAt = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
) {
  return yield* marketMomentAt(instant).pipe(
    Effect.map((moment): Window => {
      if (!moment.streaming) return "closed"
      return moment.phase === "pre-opening" || moment.phase === "pre-closing"
        ? "auction"
        : "open"
    }),
    Effect.catchTag("ScheduleYearMissing", (error) =>
      Effect.as(
        Effect.logWarning(`No IDX schedule for ${error.year}`),
        "closed" as const
      )
    )
  )
})
