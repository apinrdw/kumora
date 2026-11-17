// Whether /market-live opens a recorded day because the market is shut (spec
// apinrdw/kumora#138, "Closed market and recorded days"), on Market Live's
// clock, so the Test stage's shifted clock decides it as it decides the phase.
import {
  closedTradingDay,
  marketMomentAt,
  nextOpenAfter,
  wibDateAt,
  wibDayEnd,
  wibDayStart,
  type MarketPhase,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"

// The trading day the page opens at its close, the phase (closed or holiday)
// and the next open in epoch ms; the clock's own WIB date, which the live
// page's code list is fetched for; and how many ms until the answer may
// change.
export type ClosedMarket = {
  readonly closed?: {
    readonly day: WibDate
    readonly phase: MarketPhase
    readonly nextOpen?: number
  }
  readonly today: WibDate
  readonly changesIn: number
}

// The instants of a WIB day the answer can change at: the relay starts
// streaming, the day seals, the date turns.
const CHANGES = ["08:40:00", "17:00:00", "24:00:00"] as const

// The WIB date at `now`, and its midnight and the next, in epoch ms.
const wibDayAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
  const date = yield* wibDateAt(now)
  const midnight = DateTime.toEpochMillis(yield* wibDayStart(date))
  const nextMidnight = DateTime.toEpochMillis(yield* wibDayEnd(date))
  return { date, midnight, nextMidnight }
})

// Market Bubbles' live day at `now`, and how many ms until the date turns,
// when the page asks again.
export const liveDayAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
  const { date, nextMidnight } = yield* wibDayAt(now)
  return {
    today: date,
    dayEndsIn: nextMidnight - DateTime.toEpochMillis(now),
  }
})

// A year past the baked schedule reads as open: the live page shows.
export const closedMarketAt = Effect.fnUntraced(function* (now: DateTime.Utc) {
  const { date, midnight, nextMidnight } = yield* wibDayAt(now)
  const at = DateTime.toEpochMillis(now)
  const next = CHANGES.map((time) => {
    const [hours = 0, minutes = 0] = time.split(":").map(Number)
    return midnight + (hours * 60 + minutes) * 60_000
  }).find((change) => change > at)
  const changesIn = (next ?? nextMidnight) - at
  const day = yield* closedTradingDay(now).pipe(
    Effect.catchTag("ScheduleYearMissing", () =>
      Effect.succeed(Option.none<WibDate>())
    )
  )
  if (Option.isNone(day))
    return { today: date, changesIn } satisfies ClosedMarket
  const { phase } = yield* marketMomentAt(now)
  const nextOpen = yield* nextOpenAfter(now)
  return {
    closed: {
      day: day.value,
      phase,
      ...(nextOpen === undefined
        ? {}
        : { nextOpen: DateTime.toEpochMillis(nextOpen) }),
    },
    today: date,
    changesIn,
  } satisfies ClosedMarket
})
