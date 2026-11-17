// When broker codes walks run (spec apinrdw/kumora#244, "The extension: the
// run queue"), from the shared IDX schedule.
import {
  WibDate,
  isTradingDay,
  marketMomentAt,
  streamingEndOf,
  wibDateAt,
} from "@workspace/relay"
import { Context, DateTime, Effect, Option } from "effect"

// Decision: the walks read Streaming hours, the newest closed day and
// Ajaib's window on the relay's schedule clock, which the test clock offset
// moves (settings.ts), so an e2e spec walks a closed day at any hour. The
// service worker provides it; anywhere else it is the real clock. Tape
// queries keep the real time. See apinrdw/kumora#273.
export const ScheduleClock = Context.Reference<Effect.Effect<DateTime.Utc>>(
  "extension/ScheduleClock",
  { defaultValue: () => DateTime.now }
)
export const scheduleNow = Effect.flatten(ScheduleClock)

// Decision: walks run only outside Streaming hours (schedule.ts in
// @workspace/relay), so the live relay keeps the tab and the account's
// calls (apinrdw/kumora#196). A year missing from the schedule reads as
// outside it, as the relay's own window does (gate.ts).
export const inStreamingHours = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
) {
  return yield* marketMomentAt(instant).pipe(
    Effect.map((moment) => moment.streaming),
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(false))
  )
})

// Whether `instant` is past `date`'s Streaming hours: its day closed.
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
// trading day, else the latest trading day before. None in Streaming
// hours or past the baked schedule.
export const newestClosedDay = Effect.fnUntraced(
  function* (instant: DateTime.DateTime) {
    if (yield* inStreamingHours(instant)) return Option.none<WibDate>()
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

// The last `count` trading days closed at `instant`, newest first, in
// Streaming hours or not: the options page's list of days. Empty past the
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

// Decision: Ajaib's walk of a day runs from the close until 00:00 WIB that
// night, retrying whatever stops it; then Stockbit takes the day. The tape
// holds only the day's own evening, and the owner wants Ajaib's faster walk
// tried all evening before Stockbit's (2026-11-17).
export const ajaibWindowEnd = (day: WibDate) =>
  Effect.succeed(
    DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00+07:00`), { days: 1 })
  )
