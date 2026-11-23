// When a hot day turns cold (spec apinrdw/kumora#556, "Hot and cold days"):
// the 10-trading-day window a day leaves, and the hours a move runs in.
import {
  WibDate,
  isTradingDay,
  marketMomentAt,
  sealInstant,
  streamingEndOf,
  wibDateAt,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: a day stays hot while it is one of the newest ten trading days
// (apps/dashboard/docs/adr/0074-a-day-stays-hot-while-one-of-the-newest-ten.md)
const WINDOW = 10

// Whether `date` is a trading day; a year the schedule doesn't bake counts
// its weekdays.
const trading = (date: WibDate) =>
  isTradingDay(date).pipe(
    Effect.catchTag("ScheduleYearMissing", () =>
      Effect.sync(() => {
        const { weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(date))
        return weekDay >= 1 && weekDay <= 5
      })
    )
  )

const shifted = (date: WibDate, days: number) =>
  Effect.sync(() =>
    WibDate.make(
      DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(date), { days }))
    )
  )

// Whether `date` has left the window at `now`: ten trading days came after
// it, the latest counted from its seal.
export const pastWindow = Effect.fnUntraced(function* (
  date: WibDate,
  now: DateTime.Utc
) {
  const today = yield* wibDateAt(now)
  const sealedToday = !DateTime.isLessThan(now, yield* sealInstant(today))
  let after = 0
  for (let day = yield* shifted(date, 1); day <= today;) {
    if (day === today && !sealedToday) break
    if (yield* trading(day)) after++
    if (after === WINDOW) return true
    day = yield* shifted(day, 1)
  }
  return false
})

// The trading day that leaves the window at `date`'s seal: the tenth before
// it.
export const leavingAt = Effect.fnUntraced(function* (date: WibDate) {
  let before = 0
  for (let day = yield* shifted(date, -1); ; day = yield* shifted(day, -1))
    if ((yield* trading(day)) && ++before === WINDOW) return day
})

// A move runs outside Streaming hours, so its reads and R2 writes
// never share the object with live ingest: a step due inside them waits
// for their end. A date past the baked schedule has none. See spec
// apinrdw/kumora#556, "The move".
export const outsideStreaming = Effect.fnUntraced(function* (at: DateTime.Utc) {
  const moment = yield* marketMomentAt(at).pipe(
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(undefined))
  )
  if (moment === undefined || !moment.streaming) return at
  return DateTime.add(yield* streamingEndOf(moment.date), { milliseconds: 1 })
})
