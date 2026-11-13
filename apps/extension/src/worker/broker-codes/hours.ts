// When broker codes walks run (spec apinrdw/kumora#244, "The extension: the
// run queue"), from the shared IDX schedule.
import {
  WibDate,
  isTradingDay,
  marketMomentAt,
  streamingEndOf,
  streamingStartOf,
  wibDateAt,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"

// Decision: walks run only outside the Streaming window (schedule.ts in
// @workspace/relay), so the live relay keeps the tab and the account's
// calls (apinrdw/kumora#196). A year missing from the schedule reads as
// outside it, as the relay's own window does (gate.ts).
export const inStreamingWindow = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
) {
  return yield* marketMomentAt(instant).pipe(
    Effect.map((moment) => moment.streaming),
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(false))
  )
})

// Whether `instant` is past `date`'s Streaming window: its day closed.
const closedOn = Effect.fnUntraced(function* (
  instant: DateTime.DateTime,
  date: WibDate
) {
  return DateTime.isGreaterThan(instant, yield* streamingEndOf(date))
})

const daysFrom = Effect.fnUntraced(function* (date: WibDate, days: number) {
  return WibDate.make(
    DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(date), { days }))
  )
})

// The weekday before `date`, a holiday or not: the History walk goes back
// past the baked schedule, where only Stockbit's tape knows a holiday.
export const weekdayBefore = Effect.fnUntraced(function* (date: WibDate) {
  let before = yield* daysFrom(date, -1)
  while (
    [0, 6].includes(DateTime.toPartsUtc(DateTime.makeUnsafe(before)).weekDay)
  )
    before = yield* daysFrom(before, -1)
  return before
})

// The trading day the run queue works on at `instant`: today from 16:35 on a
// trading day, else the latest trading day before. None in the Streaming
// window or past the baked schedule.
export const newestClosedDay = Effect.fnUntraced(
  function* (instant: DateTime.DateTime) {
    if (yield* inStreamingWindow(instant)) return Option.none<WibDate>()
    const today = yield* wibDateAt(instant)
    if ((yield* isTradingDay(today)) && (yield* closedOn(instant, today)))
      return Option.some(today)
    for (let days = 1; days <= 31; days++) {
      const before = yield* daysFrom(today, -days)
      if (yield* isTradingDay(before)) return Option.some(before)
    }
    return Option.none<WibDate>()
  },
  Effect.catchTag("ScheduleYearMissing", () =>
    Effect.succeed(Option.none<WibDate>())
  )
)

// The last `count` trading days closed at `instant`, newest first, in the
// Streaming window or not: the options page's list of days. Empty past the
// baked schedule.
export const recentClosedDays = Effect.fnUntraced(
  function* (instant: DateTime.DateTime, count: number) {
    const today = yield* wibDateAt(instant)
    const closed = yield* closedOn(instant, today)
    const days: Array<WibDate> = []
    for (let back = closed ? 0 : 1; days.length < count && back <= 62; back++) {
      const day = yield* daysFrom(today, -back)
      if (yield* isTradingDay(day)) days.push(day)
    }
    return days
  },
  Effect.catchTag("ScheduleYearMissing", () =>
    Effect.succeed<ReadonlyArray<WibDate>>([])
  )
)

// The trading days after `after` and before `before`, oldest first: the
// evenings a closed browser missed. Empty past the baked schedule.
export const tradingDaysBetween = Effect.fnUntraced(
  function* (after: WibDate, before: WibDate) {
    const days: Array<WibDate> = []
    for (let day = yield* daysFrom(after, 1); day < before;) {
      if (yield* isTradingDay(day)) days.push(day)
      day = yield* daysFrom(day, 1)
    }
    return days
  },
  Effect.catchTag("ScheduleYearMissing", () =>
    Effect.succeed<ReadonlyArray<WibDate>>([])
  )
)

// Decision: Ajaib's tape holds only the day's own evening, so its window
// runs from the close until 08:40 WIB on the next trading day
// (apinrdw/kumora#244, "Ajaib's window"). None past the baked schedule.
export const ajaibWindowEnd = Effect.fnUntraced(
  function* (day: WibDate) {
    for (let days = 1; days <= 31; days++) {
      const next = yield* daysFrom(day, days)
      if (yield* isTradingDay(next))
        return Option.some(yield* streamingStartOf(next))
    }
    return Option.none<DateTime.Utc>()
  },
  Effect.catchTag("ScheduleYearMissing", () =>
    Effect.succeed(Option.none<DateTime.Utc>())
  )
)
