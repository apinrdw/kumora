import { DateTime, Effect, Option, Schema } from "effect"

// A calendar date in WIB (UTC+7, no DST), `YYYY-MM-DD`. A trading day is one
// of these.
export const WibDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)
).pipe(Schema.brand("WibDate"))
export type WibDate = typeof WibDate.Type

export const MarketPhase = Schema.Literals([
  "pre-opening",
  "session-1",
  "break",
  "session-2",
  "pre-closing",
  "post-trading",
  "closed",
  "holiday",
])
export type MarketPhase = typeof MarketPhase.Type

export class ScheduleYearMissing extends Schema.TaggedError<ScheduleYearMissing>()(
  "ScheduleYearMissing",
  { year: Schema.Int }
) {}

// Decision: holidays are baked from IDX's yearly PDF announcement, not read
// from Ajaib's trading-day/detail at runtime: that needs the signed-in tab and
// covers only today. Add each year when IDX publishes it (around September),
// plus any mid-year announcement. A year with no entry fails with
// ScheduleYearMissing. See apinrdw/kumora#56.
const holidays: Readonly<Record<number, ReadonlySet<string>>> = {
  // Peng-00171/BEI.POP/09-2025: 22 holidays, 239 trading days.
  2026: new Set([
    "01-01",
    "01-16",
    "02-16",
    "02-17",
    "03-18",
    "03-19",
    "03-20",
    "03-23",
    "03-24",
    "04-03",
    "05-01",
    "05-14",
    "05-15",
    "05-27",
    "05-28",
    "06-01",
    "06-16",
    "08-17",
    "08-25",
    "12-24",
    "12-25",
    "12-31",
  ]),
  // IDX trading holiday calendar 2027: 20 holidays, 241 trading days.
  2027: new Set([
    "01-01",
    "01-05",
    "02-05",
    "03-08",
    "03-09",
    "03-10",
    "03-11",
    "03-12",
    "03-15",
    "03-25",
    "03-26",
    "05-06",
    "05-17",
    "05-18",
    "05-19",
    "05-20",
    "06-01",
    "08-17",
    "12-24",
    "12-31",
  ]),
}

// A WIB wall-clock time, `HH:MM:SS`. Zero-padded, so it orders as a string.
type Time = `${number}:${number}:${number}`

// From a first second to a last, inclusive, as IDX Rule II-A writes them.
type Span = { readonly first: Time; readonly last: Time }

// One market phase's stretch of a trading day.
type Stretch = Span & { readonly phase: MarketPhase }

const opening: ReadonlyArray<Stretch> = [
  { phase: "pre-opening", first: "08:45:00", last: "08:59:59" },
]
const closing: ReadonlyArray<Stretch> = [
  { phase: "pre-closing", first: "15:50:00", last: "16:01:59" },
  { phase: "post-trading", first: "16:02:00", last: "16:15:00" },
]

// Decision: session times from IDX Rule II-A, Kep-00158/BEI/10-2026 (in force
// 20 Oct 2026), section IV.2. Only Friday differs, with a longer break; there
// are no Ramadan hours and no half days. Pre-closing runs through the closing
// match. See apinrdw/kumora#56.
const mondayToThursday: ReadonlyArray<Stretch> = [
  ...opening,
  { phase: "session-1", first: "09:00:00", last: "12:00:00" },
  { phase: "break", first: "12:00:01", last: "13:29:59" },
  { phase: "session-2", first: "13:30:00", last: "15:49:59" },
  ...closing,
]
const friday: ReadonlyArray<Stretch> = [
  ...opening,
  { phase: "session-1", first: "09:00:00", last: "11:30:00" },
  { phase: "break", first: "11:30:01", last: "13:59:59" },
  { phase: "session-2", first: "14:00:00", last: "15:49:59" },
  ...closing,
]

// The stretches that expect trades: continuous trading, post-trading, and the
// minute each auction matches in. Every other stretch is expected-quiet, so a
// quiet feed there stays live.
const tradingPhases: ReadonlySet<MarketPhase> = new Set([
  "session-1",
  "session-2",
  "post-trading",
])
const auctionMatchMinutes: ReadonlyArray<Span> = [
  { first: "08:58:00", last: "08:58:59" },
  { first: "16:00:00", last: "16:00:59" },
]

// Decision: the relay streams 08:40–16:35 WIB, five minutes before
// pre-opening to five minutes after the negotiated market ends, breaks
// included. A narrower window loses auction data; a wider one costs little.
const streaming: Span = { first: "08:40:00", last: "16:34:59" }

export const isTradingDay = Effect.fnUntraced(function* (date: WibDate) {
  const year = Number(date.slice(0, 4))
  const yearHolidays = holidays[year]
  if (yearHolidays === undefined) {
    return yield* new ScheduleYearMissing({ year })
  }
  const { weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(date))
  return weekDay >= 1 && weekDay <= 5 && !yearHolidays.has(date.slice(5))
})

// Where the exchange is at one instant: the WIB date, its market phase,
// whether trades are expected, and whether the relay streams.
export type MarketMoment = {
  readonly date: WibDate
  readonly phase: MarketPhase
  readonly expectsTrades: boolean
  readonly streaming: boolean
}

// The WIB date of an instant. Unlike marketMomentAt it needs no baked year, so
// it names a trading-day Durable Object on any date.
export const wibDateAt = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
) {
  return WibDate.make(
    DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(0, 10)
  )
})

export const marketMomentAt = Effect.fnUntraced(function* (
  instant: DateTime.DateTime
): Effect.fn.Return<MarketMoment, ScheduleYearMissing> {
  // `YYYY-MM-DDTHH:MM:SS.sssZ` of the WIB wall clock.
  const wib = DateTime.formatIso(DateTime.add(instant, { hours: 7 }))
  const date = yield* wibDateAt(instant)
  const at = wib.slice(11, 19)
  const { weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(date))
  const covers = (span: Span) => span.first <= at && at <= span.last
  if (!(yield* isTradingDay(date))) {
    const weekend = weekDay === 0 || weekDay === 6
    const phase: MarketPhase = weekend ? "closed" : "holiday"
    return { date, phase, expectsTrades: false, streaming: false }
  }
  const day = weekDay === 5 ? friday : mondayToThursday
  const phase = day.find(covers)?.phase ?? "closed"
  return {
    date,
    phase,
    expectsTrades: tradingPhases.has(phase) || auctionMatchMinutes.some(covers),
    streaming: covers(streaming),
  }
})

// The instant a trading day is sealed into a recorded day: 17:00 WIB.
export const sealInstant = Effect.fnUntraced(function* (date: WibDate) {
  return DateTime.makeUnsafe(`${date}T17:00:00+07:00`)
})

// The market opens with pre-opening, 08:45 WIB.
const OPENS_AT = "08:45:00"

// The next trading day's opening after `instant`, looking up to a month
// ahead. Undefined past the baked schedule.
export const nextOpenAfter = Effect.fnUntraced(
  function* (instant: DateTime.Utc) {
    for (let days = 0; days <= 31; days++) {
      const date = WibDate.make(
        DateTime.formatIsoDate(DateTime.add(instant, { hours: 7, days }))
      )
      const open = DateTime.makeUnsafe(`${date}T${OPENS_AT}+07:00`)
      if (DateTime.Order(open, instant) <= 0) continue
      if (yield* isTradingDay(date)) return open
    }
    return undefined
  },
  Effect.catchTag("ScheduleYearMissing", () => Effect.succeed(undefined))
)

// The trading day Market Live opens at its close while the market is shut
// (spec apinrdw/kumora#138, "Closed market and recorded days"): on a weekend
// or holiday, and before the relay streams (08:40) on a trading day, the
// latest trading day before; from a trading day's 17:00 seal, that day. None
// from 08:40 until the seal: the live page shows the day, its close included.
export const closedMarketDay = Effect.fnUntraced(function* (
  instant: DateTime.Utc
) {
  const date = yield* wibDateAt(instant)
  const at = DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(
    11,
    19
  )
  if ((yield* isTradingDay(date)) && at >= streaming.first)
    return DateTime.isLessThan(instant, yield* sealInstant(date))
      ? Option.none<WibDate>()
      : Option.some(date)
  for (let days = 1; days <= 31; days++) {
    const before = WibDate.make(
      DateTime.formatIsoDate(DateTime.add(instant, { hours: 7, days: -days }))
    )
    if (yield* isTradingDay(before)) return Option.some(before)
  }
  return Option.none<WibDate>()
})

// One stretch of a trading day as instants, from its first second to just
// after its last.
export type Interval = {
  readonly from: DateTime.Utc
  readonly to: DateTime.Utc
}

// The stretches of `date` that expect trades, in order: the 08:58 match
// minute, session 1, session 2, the 16:00 match minute and post-trading
// (adjacent stretches joined). None on a weekend or holiday. Freshness counts
// silence and relay gaps only inside these.
export const expectedStretches = Effect.fnUntraced(function* (date: WibDate) {
  if (!(yield* isTradingDay(date))) return []
  const { weekDay } = DateTime.toPartsUtc(DateTime.makeUnsafe(date))
  const day = weekDay === 5 ? friday : mondayToThursday
  const spans = [
    ...auctionMatchMinutes,
    ...day.filter((stretch) => tradingPhases.has(stretch.phase)),
  ]
    .map((span) => ({
      from: DateTime.makeUnsafe(`${date}T${span.first}+07:00`),
      to: DateTime.add(DateTime.makeUnsafe(`${date}T${span.last}+07:00`), {
        seconds: 1,
      }),
    }))
    .sort((a, b) => DateTime.Order(a.from, b.from))
  const joined: Array<Interval> = []
  for (const span of spans) {
    const last = joined.at(-1)
    if (last !== undefined && DateTime.Order(last.to, span.from) >= 0)
      joined[joined.length - 1] = {
        from: last.from,
        to: DateTime.max(last.to, span.to),
      }
    else joined.push(span)
  }
  return joined
})
