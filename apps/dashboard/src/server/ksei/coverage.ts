// The KSEI archive's coverage: for each KSEI report kind, every month from
// 2008 to the current one, held, not found or never looked for (spec
// apinrdw/kumora#327, "The admin page").
import { wibDateAt } from "@workspace/relay"
import { type DateTime, Effect, Schema } from "effect"

import type { ListedObject } from "../archive/bucket.ts"
import { kindPrefix } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import type { DeepFinds } from "./run-result.ts"

// The oldest year KSEI serves files for: the first year the grid shows, and
// the first a Deep backfill probes (deep.ts).
export const FIRST_YEAR = 2008

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
        // January first.
        months: Schema.Array(CoverageState),
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
  const lastYear = Number(today.slice(0, 4))
  const lastMonth = Number(today.slice(5, 7))
  const kinds = yield* Effect.forEach(KseiReportKind.literals, (kind) =>
    Effect.map(monthsHeld(objects, kind), (held) => {
      const notFound = new Set(monthsNotFound?.[kind])
      const state = (month: string): CoverageState =>
        held.has(month)
          ? "held"
          : notFound.has(month)
            ? "not-found"
            : "never-looked-for"
      return {
        kind,
        years: Array.from(
          { length: lastYear - FIRST_YEAR + 1 },
          (_, i) => FIRST_YEAR + i
        ).map((year) => ({
          year,
          months: Array.from(
            { length: year === lastYear ? lastMonth : 12 },
            (_, m) => state(`${year}-${String(m + 1).padStart(2, "0")}`)
          ),
        })),
      }
    })
  )
  return KseiCoverage.make(kinds)
})
