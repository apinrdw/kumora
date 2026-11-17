// The KSEI archive's coverage: for each KSEI report kind, every month from
// FIRST_MONTH to the current one, held, not found or never looked for (spec
// apinrdw/kumora#327, "The admin page").
import { wibDateAt } from "@workspace/relay"
import { type DateTime, Effect, Schema } from "effect"

import type { ListedObject } from "../archive/bucket.ts"
import { monthGrid } from "../archive/month-grid.ts"
import { kindPrefix } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import type { DeepFinds } from "./run-result.ts"

// The archive's first month, as YYYY-MM: the first the grid shows, the first
// a Deep backfill probes (deep.ts), and the first whose reports a run stores
// (archive-run.ts, deep.ts).
// Decision: November 2018 for both kinds. The owner chose on 2026-11-15 to
// keep 2018-11 onward only; Production then held Statistik Efek 2008-01 to
// 2013-04 and Kepemilikan Efek 2008-04 to 2013-04 and 2018-01 to 2018-10,
// then a gap, and those earlier reports were deleted once by hand.
const FIRST_MONTH = "2018-11"

export const FIRST_YEAR = Number(FIRST_MONTH.slice(0, 4))

// Whether `period`, a period end (YYYY-MM-DD) or a month (YYYY-MM), is in
// the archive: from FIRST_MONTH on. Both compare as text.
export const inArchive = Effect.fnUntraced(function* (period: string) {
  return period >= FIRST_MONTH
})

// held: the archive has a record of a file for the month. not-found: the
// latest deep run probed the month and found nothing. never-looked-for:
// neither, which includes a month whose probe step failed.
const CoverageState = Schema.Literals(["held", "not-found", "never-looked-for"])
export type CoverageState = typeof CoverageState.Type

const KseiCoverage = Schema.Array(
  Schema.Struct({
    kind: KseiReportKind,
    // Oldest first; the last year ends at the current month.
    years: Schema.Array(
      Schema.Struct({
        year: Schema.Number,
        // January first; null before FIRST_MONTH.
        months: Schema.Array(Schema.NullOr(CoverageState)),
      })
    ),
  })
)
export type KseiCoverage = typeof KseiCoverage.Type

// The months of `kind` with a record in `objects`, a listing of reports/, as
// YYYY-MM. A record is written after its zip, so it marks a whole version.
export const monthsHeld = Effect.fnUntraced(function* (
  objects: ReadonlyArray<ListedObject>,
  kind: KseiReportKind
) {
  const prefix = yield* kindPrefix(kind)
  return new Set(
    objects
      .filter(({ key }) => key.startsWith(prefix) && key.endsWith(".json"))
      // reports/<kind>/<YYYY-MM-DD>/<record>.json
      .map(({ key }) => key.slice(prefix.length, prefix.length + 7))
  )
})

// Each kind's months up to `now`'s month in WIB, from a listing of reports/
// and the latest deep run's months not found, if there is one.
export const kseiCoverage = Effect.fnUntraced(function* (
  objects: ReadonlyArray<ListedObject>,
  monthsNotFound: DeepFinds["monthsNotFound"] | undefined,
  now: DateTime.DateTime
) {
  const today = yield* wibDateAt(now)
  const kinds = yield* Effect.forEach(
    KseiReportKind.literals,
    Effect.fnUntraced(function* (kind) {
      const held = yield* monthsHeld(objects, kind)
      const notFound = new Set(monthsNotFound?.[kind])
      const state = Effect.fnUntraced(function* (month: string) {
        if (!(yield* inArchive(month))) return null
        return held.has(month)
          ? "held"
          : notFound.has(month)
            ? "not-found"
            : "never-looked-for"
      })
      return {
        kind,
        years: yield* monthGrid(FIRST_YEAR, today.slice(0, 7), state),
      }
    })
  )
  return KseiCoverage.make(kinds)
})
