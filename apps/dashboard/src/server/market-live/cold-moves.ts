// The daily reconcile cron's moves to R2 (spec apinrdw/kumora#556, "The
// move"): the backstop asks each recent day the index lists hot to move, the
// backfill a few older ones, and its object moves a day if it is due
// (trading-day.ts `startMove`). broker-totals/cron.ts runs both on the
// Worker's bindings.
import type { RecordedDay, WibDate } from "@workspace/relay"
import { Effect } from "effect"

// Decision: the newest 15 recorded days still hot, the window and the 5
// that left it last, so a day whose seal's ask or start failed moves within
// days. Older hot days, recorded before cold days, are the backfill's to
// move a few a night (apinrdw/kumora#582). See spec apinrdw/kumora#556,
// "The move".
const BACKSTOP_DAYS = 15

// Decision: the backfill starts 3 moves a night, oldest first. A busy day
// recorded before trade chunks reads about 1.85 M rows to move (385 K on
// chunks, plus its 1.46 M trade rows), so about 5.6 M rows a night and the
// ~30 old days in ten nights. A day already moving counts: it reads tonight.
// See spec apinrdw/kumora#556, "Backfill".
const MOVES_PER_NIGHT = 3

// The day index's rows, newest first.
const newestFirst = <E, R>(
  listed: Effect.Effect<ReadonlyArray<RecordedDay>, E, R>
) =>
  Effect.map(listed, (rows) =>
    // A WIB date is ISO, so a later one sorts after.
    [...rows].sort((a, b) => (a.day < b.day ? 1 : -1))
  )

// Asks one day's object to move: whether it moves; a failed ask is logged
// and counts as not.
const asked = <R>(
  ask: (day: WibDate) => Effect.Effect<boolean, unknown, R>,
  day: WibDate
) =>
  ask(day).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Move not asked", cause).pipe(
        Effect.annotateLogs({ day }),
        Effect.as(false)
      )
    )
  )

export const askDueMoves = Effect.fnUntraced(function* <E, R>(
  // The day index's rows.
  listed: Effect.Effect<ReadonlyArray<RecordedDay>, E, R>,
  // Asks one day's object to move; whether it moves.
  ask: (day: WibDate) => Effect.Effect<boolean, unknown, R>
) {
  const days = (yield* newestFirst(listed))
    .slice(0, BACKSTOP_DAYS)
    .filter((row) => row.cold !== true)
  let moving = 0
  for (const { day } of days) if (yield* asked(ask, day)) moving++
  yield* Effect.logInfo("Moves asked").pipe(
    Effect.annotateLogs({ askedDays: days.length, movingDays: moving })
  )
})

// The backfill: the hot days older than the backstop's, oldest first, asked
// until MOVES_PER_NIGHT move. A day not due (its build pending) or not
// reached is asked again the next night. Only the index's days are asked,
// so no object is made for a day never recorded.
export const askBackfillMoves = Effect.fnUntraced(function* <E, R>(
  listed: Effect.Effect<ReadonlyArray<RecordedDay>, E, R>,
  ask: (day: WibDate) => Effect.Effect<boolean, unknown, R>
) {
  const days = (yield* newestFirst(listed))
    .slice(BACKSTOP_DAYS)
    .filter((row) => row.cold !== true)
    .reverse()
  let askedDays = 0
  let moving = 0
  for (const { day } of days) {
    if (moving === MOVES_PER_NIGHT) break
    askedDays++
    if (yield* asked(ask, day)) moving++
  }
  yield* Effect.logInfo("Backfill moves asked").pipe(
    Effect.annotateLogs({
      askedDays,
      movingDays: moving,
      hotDays: days.length,
    })
  )
})
