// The exchange's hours, in WIB. A file in the repo: changes are reviewed commits and
// a deploy. A wrong one costs a label, because the feed wins.
//
// The regular market's hours are from IDX's Trading Hours and Mechanism page
// (https://www.idx.id/en/products-services/trading-hours-and-mechanism/, Rule II-A,
// Kep-00158/BEI/10-2026), checked 2026-11-02. `pre-open` covers pre-opening input
// and matching, 08:45–08:59:59. `closing-auction` is pre-closing input and matching,
// 15:50–16:01:59. `post-closing` runs 16:02–16:15:00. They are the same Monday to
// Friday. Only the sessions and the break differ on Friday.
//
// Free of `effect`, because the live page's chart reads the hours too. The Worker's
// decoder for an override is in calendar-override.ts.
import { WIB_MS } from "./trading-day"

export const PHASES = [
  "pre-open",
  "session-1",
  "break",
  "session-2",
  "closing-auction",
  "post-closing",
  "closed",
] as const
export type Phase = (typeof PHASES)[number]

/** Half open, in `HH:MM` WIB, so it compares as text. */
export interface Hours {
  readonly phase: Phase
  readonly from: string
  readonly to: string
}

export interface Calendar {
  /** By calendar year; a year's presence, even empty, says the operator listed it. */
  readonly holidays: { readonly [year: string]: ReadonlyArray<string> }
  /** By `YYYY-MM-DD`: that date's hours, in place of its usual ones. */
  readonly exceptions: { readonly [date: string]: ReadonlyArray<Hours> }
}

/**
 * The operator keeps this list, from IDX's Kalender Libur Bursa. Do not invent one:
 * a missing year reads out of date.
 */
export const CALENDAR: Calendar = {
  holidays: {
    "2026": [
      "2026-01-01",
      "2026-01-16",
      "2026-02-16",
      "2026-02-17",
      "2026-03-18",
      "2026-03-19",
      "2026-03-20",
      "2026-03-23",
      "2026-03-24",
      "2026-04-03",
      "2026-05-01",
      "2026-05-14",
      "2026-05-15",
      "2026-05-27",
      "2026-05-28",
      "2026-06-01",
      "2026-06-16",
      "2026-08-17",
      "2026-08-25",
      "2026-12-24",
      "2026-12-25",
      "2026-12-31",
    ],
    "2027": [
      "2027-01-01",
      "2027-01-05",
      "2027-02-05",
      "2027-03-08",
      "2027-03-09",
      "2027-03-10",
      "2027-03-11",
      "2027-03-12",
      "2027-03-15",
      "2027-03-25",
      "2027-03-26",
      "2027-05-06",
      "2027-05-17",
      "2027-05-18",
      "2027-05-19",
      "2027-05-20",
      "2027-06-01",
      "2027-08-17",
      "2027-12-24",
      "2027-12-31",
    ],
  },
  exceptions: {},
}

const day = (
  session1End: string,
  session2Start: string
): ReadonlyArray<Hours> => [
  { phase: "pre-open", from: "08:45", to: "09:00" },
  { phase: "session-1", from: "09:00", to: session1End },
  { phase: "break", from: session1End, to: session2Start },
  { phase: "session-2", from: session2Start, to: "15:50" },
  { phase: "closing-auction", from: "15:50", to: "16:02" },
  { phase: "post-closing", from: "16:02", to: "16:15" },
]

const MON_THU = day("12:00", "13:30")
const FRI = day("11:30", "14:00")
const FRIDAY = 5
export const SATURDAY = 6
export const SUNDAY = 0

/** `YYYY-MM-DDTHH:MM` in WIB. */
const wib = (now: number) =>
  new Date(now + WIB_MS).toISOString().slice(0, "YYYY-MM-DDTHH:MM".length)

const weeklyHours = (date: string): ReadonlyArray<Hours> => {
  const weekday = new Date(Date.parse(date)).getUTCDay()
  if (weekday === SATURDAY || weekday === SUNDAY) return []
  return weekday === FRIDAY ? FRI : MON_THU
}

/** By `YYYY-MM-DD`. False for any date in a year with no list. */
export const isHoliday = (
  date: string,
  calendar: Calendar = CALENDAR
): boolean => calendar.holidays[date.slice(0, 4)]?.includes(date) ?? false

/** A `YYYY-MM-DD`'s hours, earliest first: none on a holiday or a weekend. */
export const hoursOn = (
  date: string,
  calendar: Calendar = CALENDAR
): ReadonlyArray<Hours> =>
  calendar.exceptions[date] ??
  (isHoliday(date, calendar) ? [] : weeklyHours(date))

export const phaseAt = (now: number, calendar: Calendar = CALENDAR): Phase => {
  const [date = "", time = ""] = wib(now).split("T")
  return (
    hoursOn(date, calendar).find((h) => h.from <= time && time < h.to)?.phase ??
    "closed"
  )
}

/** A year with no list still runs on the weekly hours, and says so. */
export const calendarOutOfDate = (
  now: number,
  calendar: Calendar = CALENDAR
): boolean => calendar.holidays[wib(now).slice(0, 4)] === undefined

const MINUTE_MS = 60_000
/** Longer than any listed closure; past it, the alarm looks again rather than spin. */
const NEXT_OPEN_LIMIT_MS = 14 * 24 * 60 * MINUTE_MS

/** The first minute after `now` that is not `closed`. */
export const nextOpen = (
  now: number,
  calendar: Calendar = CALENDAR
): number => {
  const first = now - (now % MINUTE_MS) + MINUTE_MS
  for (let at = first; at - now < NEXT_OPEN_LIMIT_MS; at += MINUTE_MS)
    if (phaseAt(at, calendar) !== "closed") return at
  return now + NEXT_OPEN_LIMIT_MS
}
