// Disclosure days: the WIB date IDX publishes a disclosure on, and the day
// arithmetic the runs and the coverage share.
import { WibDate, wibDateAt } from "@workspace/relay"
import { DateTime, Duration, Effect } from "effect"

import { type DisclosureKey, publishDateOf } from "./key.ts"

// IDX's first disclosure day: GetAnnouncement listed nothing before 3 July
// 2023 when probed on 2026-11-26. The last day a run's backfill walks back
// to (archive-run.ts) and the first the coverage shows (coverage.ts).
// Decision: each disclosure run backfills the newest incomplete days with its leftover budget
// (apps/dashboard/docs/adr/0142-disclosure-runs-backfill-the-newest-incomplete-days.md)
export const FIRST_DISCLOSURE_DAY = WibDate.make("2023-07-03")

// The disclosure days each run lists again: today in WIB and the 6 before,
// so a version or attachment IDX adds within a week is stored.
export const RECENT_DAYS = 7

// How long an attachment's failures span before it is unavailable.
// Decision: an attachment whose failures span 7 days is unavailable
// (apps/dashboard/docs/adr/0139-an-attachment-failing-for-7-days-is-unavailable.md)
export const UNAVAILABLE_AFTER = Duration.days(7)

const daysFrom = (day: WibDate, days: number) =>
  WibDate.make(
    DateTime.formatIsoDate(
      DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days })
    )
  )

// The day after `day`.
export const dayAfter = Effect.fnUntraced(function* (day: WibDate) {
  return daysFrom(day, 1)
})

// The day before `day`.
export const dayBefore = Effect.fnUntraced(function* (day: WibDate) {
  return daysFrom(day, -1)
})

// The disclosure day a key was published on: its first eight digits, a
// day the calendar has, as DisclosureKey checks.
// Decision: a disclosure is keyed by IDX's Id2 without its language
// (apps/dashboard/docs/adr/0136-a-disclosure-is-keyed-by-id2-without-its-language.md)
export const disclosureDayOf = Effect.fnUntraced(function* (
  key: DisclosureKey
) {
  return WibDate.make(publishDateOf(key))
})

// Whether a listing at `listedAt`, an ISO instant, came after `day` ended
// in WIB: one while IDX could still add to the day doesn't count toward its
// completeness.
export const listedWhole = Effect.fnUntraced(function* (
  day: WibDate,
  listedAt: string
) {
  return (yield* wibDateAt(DateTime.makeUnsafe(listedAt))) > day
})
