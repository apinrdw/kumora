// When the relay streams (spec apinrdw/kumora#138, "Streaming hours" and
// "Auctions"), from the shared IDX schedule.
import { marketMomentAt } from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect } from "effect"

import type { Window } from "./broker.ts"

// Decision: the relay streams 08:40 to 16:35 WIB; a missing year streams nothing
// (packages/relay/docs/adr/0004-the-relay-streams-08-40-to-16-35-wib.md)
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
