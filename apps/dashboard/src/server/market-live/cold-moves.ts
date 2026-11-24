// The daily reconcile cron's moves to R2 (spec apinrdw/kumora#556, "The
// move"): the backstop asks each recent day the index lists hot to move, then
// a few older ones, and its object moves a day if it is due
// (trading-day.ts `startMove`). broker-totals/cron.ts runs both on the
// Worker's bindings.
import type { RecordedDay, WibDate } from "@workspace/relay"
import { Effect } from "effect"

// The newest 15 recorded days still hot, the window and the 5
// that left it last, so a day whose seal's ask or start failed moves within
// days. Older hot days, recorded before cold days, are asked a few a night
// (MOVES_PER_NIGHT). See spec apinrdw/kumora#556, "The move".
const BACKSTOP_DAYS = 15

// The older days start 3 moves a night, oldest first. A busy day reads
// about 385 K rows to move; the backfill was sized on days recorded before
// trade chunks, about 1.85 M each, so about 5.6 M rows a night. A day already
// moving counts: it reads tonight. See spec apinrdw/kumora#556, "The move".
const MOVES_PER_NIGHT = 3

// Where the cron's moves are asked from: the day index's rows, and the ask
// to one day's object to move, answering whether it moves.
interface MoveAsks<E, R> {
  readonly listed: Effect.Effect<ReadonlyArray<RecordedDay>, E, R>
  readonly ask: (day: WibDate) => Effect.Effect<boolean, unknown, R>
}

// The day index's hot rows, newest first, from the `from`th newest row
// listed (cold ones count) up to the `to`th.
const hotDays = <E, R>(
  listed: MoveAsks<E, R>["listed"],
  from: number,
  to?: number
) =>
  Effect.map(listed, (rows) =>
    // A WIB date is ISO, so a later one sorts after.
    [...rows]
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(from, to)
      .filter((row) => row.cold !== true)
  )

// Asks one day's object to move: whether it moves; a failed ask is logged
// and counts as not.
const asked = <E, R>(ask: MoveAsks<E, R>["ask"], day: WibDate) =>
  ask(day).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Move not asked", cause).pipe(
        Effect.annotateLogs({ day }),
        Effect.as(false)
      )
    )
  )

export const askDueMoves = Effect.fnUntraced(function* <E, R>({
  listed,
  ask,
}: MoveAsks<E, R>) {
  const days = yield* hotDays(listed, 0, BACKSTOP_DAYS)
  let moving = 0
  for (const { day } of days) if (yield* asked(ask, day)) moving++
  yield* Effect.logInfo("Moves asked").pipe(
    Effect.annotateLogs({ askedDays: days.length, movingDays: moving })
  )
})

// The older days' moves: the hot days older than the backstop's, oldest first, asked
// until MOVES_PER_NIGHT move. A day not due (its build pending) or not
// reached is asked again the next night. Only the index's days are asked,
// so no object is made for a day never recorded.
export const askOlderMoves = Effect.fnUntraced(function* <E, R>({
  listed,
  ask,
}: MoveAsks<E, R>) {
  const days = (yield* hotDays(listed, BACKSTOP_DAYS)).reverse()
  let askedDays = 0
  let moving = 0
  for (const { day } of days) {
    if (moving === MOVES_PER_NIGHT) break
    askedDays++
    if (yield* asked(ask, day)) moving++
  }
  yield* Effect.logInfo("Older moves asked").pipe(
    Effect.annotateLogs({
      askedDays,
      movingDays: moving,
      hotDays: days.length,
    })
  )
})
