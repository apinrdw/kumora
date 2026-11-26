// How far the disclosure archive reaches: each disclosure day from IDX's
// first to today in WIB, complete, incomplete or not yet listed, and the
// earliest day it holds a disclosure of (spec apinrdw/kumora#715, ticket
// #718).
import { WibDate, wibDateAt } from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect, Schema } from "effect"

import { bothReads, mapRead } from "../archive/page-read.ts"
import { dayAfter, FIRST_DISCLOSURE_DAY } from "./disclosure-day.ts"
import {
  earliestDayRead,
  type ListedDay,
  listedDaysRead,
} from "./disclosure-index.ts"

// complete: no run lists the day again. incomplete: a run listed it, and
// it is in the last 7 days, wasn't listed after it ended, or has
// attachments waiting. not-listed: no run has listed it yet.
const DisclosureCoverageState = Schema.Literals([
  "complete",
  "incomplete",
  "not-listed",
])
export type DisclosureCoverageState = typeof DisclosureCoverageState.Type

const DisclosureCoverageDay = Schema.Struct({
  date: WibDate,
  state: DisclosureCoverageState,
  // Its attachments waiting to be stored.
  waiting: Schema.Number,
})
export type DisclosureCoverageDay = typeof DisclosureCoverageDay.Type

const DisclosureCoverage = Schema.Struct({
  // The oldest disclosure day the archive holds a version of; null before
  // it holds any.
  earliestDay: Schema.NullOr(WibDate),
  // Days in each state, from FIRST_DISCLOSURE_DAY to today.
  complete: Schema.Number,
  incomplete: Schema.Number,
  notListed: Schema.Number,
  // A row per month from FIRST_DISCLOSURE_DAY's to today's, oldest first,
  // each with its days from the 1st; null before FIRST_DISCLOSURE_DAY, and
  // none past today.
  months: Schema.Array(
    Schema.Struct({
      month: Schema.String,
      days: Schema.Array(Schema.NullOr(DisclosureCoverageDay)),
    })
  ),
})
export type DisclosureCoverage = typeof DisclosureCoverage.Type

// The most bytes the coverage may take as JSON in the admin page's load: it
// grows by a day's ~55 bytes a day, ~68 KB on 2026-11-26, so this holds
// until about 2036. Its ArchiveDb read is a row a listed day too.
export const MAX_COVERAGE_BYTES = 256 * 1024

const coverageOf = Effect.fnUntraced(function* (
  listed: ReadonlyArray<ListedDay>,
  earliestDay: WibDate | null,
  now: DateTime.DateTime
) {
  const today = yield* wibDateAt(now)
  const byDay = new Map(listed.map((row) => [row.day, row]))
  const counts = { complete: 0, incomplete: 0, notListed: 0 }
  const months = new Map<string, Array<DisclosureCoverageDay | null>>()
  for (
    let date = FIRST_DISCLOSURE_DAY;
    date <= today;
    date = yield* dayAfter(date)
  ) {
    const row = byDay.get(date)
    const state: DisclosureCoverageState =
      row === undefined
        ? "not-listed"
        : row.complete_at === null
          ? "incomplete"
          : "complete"
    counts[state === "not-listed" ? "notListed" : state] += 1
    const days = months.get(date.slice(0, 7)) ?? []
    days[Number(date.slice(8, 10)) - 1] = {
      date,
      state,
      waiting: row?.waiting ?? 0,
    }
    months.set(date.slice(0, 7), days)
  }
  return DisclosureCoverage.make({
    earliestDay,
    ...counts,
    months: [...months].map(([month, days]) => ({
      month,
      // Array.from fills a sparse array's holes with undefined.
      days: Array.from(days, (day) => day ?? null),
    })),
  })
})

// The coverage up to `now`'s day in WIB, as a part of the admin page's read.
export const disclosureCoverage = (now: DateTime.DateTime) =>
  mapRead(
    bothReads(listedDaysRead(FIRST_DISCLOSURE_DAY), earliestDayRead),
    ([listed, earliest]) => coverageOf(listed, earliest, now)
  )
