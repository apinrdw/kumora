// The daily reconcile cron's backstop for moves to R2 (spec
// apinrdw/kumora#556, "The move"): each recent day the index lists hot is
// asked to move, and its object moves it if it is due (trading-day.ts
// `startMove`). broker-totals/cron.ts runs it on the Worker's bindings.
import type { RecordedDay, WibDate } from "@workspace/relay"
import { Effect } from "effect"

// Decision: the backstop asks the newest 15 recorded days still hot: the
// 10-trading-day window and the 5 days that left it last, so a day whose
// seal's ask or completing batch's start failed moves within days. Older
// hot days, the ones recorded before cold days, are the backfill's to move
// a few a night (apinrdw/kumora#582). See spec apinrdw/kumora#556, "The
// move".
const BACKSTOP_DAYS = 15

export const askDueMoves = Effect.fnUntraced(function* <E, R>(
  // The day index's rows.
  listed: Effect.Effect<ReadonlyArray<RecordedDay>, E, R>,
  // Asks one day's object to move; whether it moves.
  ask: (day: WibDate) => Effect.Effect<boolean, unknown, R>
) {
  // A WIB date is ISO, so a later one sorts after.
  const days = [...(yield* listed)]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, BACKSTOP_DAYS)
    .filter((row) => row.cold !== true)
  let moving = 0
  for (const { day } of days)
    if (
      yield* ask(day).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Move not asked", cause).pipe(
            Effect.annotateLogs({ day }),
            Effect.as(false)
          )
        )
      )
    )
      moving++
  yield* Effect.logInfo("Moves asked").pipe(
    Effect.annotateLogs({ askedDays: days.length, movingDays: moving })
  )
})
