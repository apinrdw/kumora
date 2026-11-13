// When broker codes walks run (spec apinrdw/kumora#244, "The extension: the
// run queue"), from the shared IDX schedule.
import {
  WIB_UTC_OFFSET_HOURS,
  WibDate,
  isTradingDay,
  marketMomentAt,
  wibDateAt,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"

// Decision: walks run only outside 08:40–16:35 WIB on trading days, the
// relay's streaming hours, so the live relay keeps the tab and the account's
// calls (apinrdw/kumora#196). A year missing from the schedule reads as
// outside them, as the relay's own window does (gate.ts).
export const isMarketHours = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
) {
  return yield* marketMomentAt(instant).pipe(
    Effect.map((moment) => moment.streaming),
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(false))
  )
})

const CLOSES_AT = "16:35:00"
const STREAMING_STARTS_AT = "08:40:00"

const wibTime = Effect.fnUntraced(function* (instant: DateTime.DateTime) {
  return DateTime.formatIso(
    DateTime.add(instant, { hours: WIB_UTC_OFFSET_HOURS })
  ).slice(11, 19)
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
// trading day, else the latest trading day before. None during market hours
// or past the baked schedule.
export const newestClosedDay = Effect.fnUntraced(
  function* (instant: DateTime.DateTime) {
    if (yield* isMarketHours(instant)) return Option.none<WibDate>()
    const today = yield* wibDateAt(instant)
    if ((yield* isTradingDay(today)) && (yield* wibTime(instant)) >= CLOSES_AT)
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

// Decision: Ajaib's tape holds only the day's own evening, so its window
// runs from the close until 08:40 WIB on the next trading day
// (apinrdw/kumora#244, "Ajaib's window"). None past the baked schedule.
export const ajaibWindowEnd = Effect.fnUntraced(
  function* (day: WibDate) {
    for (let days = 1; days <= 31; days++) {
      const next = yield* daysFrom(day, days)
      if (yield* isTradingDay(next))
        return Option.some(
          DateTime.makeUnsafe(`${next}T${STREAMING_STARTS_AT}+07:00`)
        )
    }
    return Option.none<DateTime.Utc>()
  },
  Effect.catchTag("ScheduleYearMissing", () =>
    Effect.succeed(Option.none<DateTime.Utc>())
  )
)
