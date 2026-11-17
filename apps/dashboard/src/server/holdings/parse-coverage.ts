// A report kind's parse coverage (GLOSSARY.md, "Parse coverage"): each
// archived month's state, laid out year by month as the KSEI Coverage card
// lays out its months (../ksei/coverage.ts). Any parse run's kind has one
// (parse-runs.ts). Spec apinrdw/kumora#458.
import { wibDateAt } from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import { needsParse, newestVersions } from "./months-to-parse.ts"
import type { ParseRunResult } from "./parse-run-result.ts"
import type { MonthSource } from "./parse-steps.ts"

// parsed: its parsed holdings come from its newest version, by the current
// parser version. stale: they come from an older version or parser version.
// failed: the last finished parse run failed on it, whatever holdings it
// has. not-parsed: it has none.
const ParseCoverageState = Schema.Literals([
  "parsed",
  "stale",
  "failed",
  "not-parsed",
])
type ParseCoverageState = typeof ParseCoverageState.Type

const ParseCoverage = Schema.Array(
  Schema.Struct({
    year: Schema.Number,
    // January to December; null for a month with no archived report.
    months: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          // The archived date the cell shows.
          date: Schema.String,
          state: ParseCoverageState,
        })
      )
    ),
  })
)
type ParseCoverage = typeof ParseCoverage.Type

// `source`'s coverage, from its first archived month's year to the current
// one in WIB (or its last archived month's, if later); empty before any
// month is archived. `lastFinished` is the
// kind's last finished parse run, whose parse failures mark months failed.
export const parseCoverage = Effect.fnUntraced(function* (
  source: MonthSource,
  lastFinished: ParseRunResult | undefined
) {
  const newest = yield* newestVersions(yield* source.prefix)
  const parsed = yield* source.parsed
  const failed = new Set(lastFinished?.parseFailures.map(({ date }) => date))
  // Decision: a cell is a month, and each kind publishes at most one report
  // a month. Should two archived dates share one, the cell shows the later:
  // `newest` is oldest first, so the later date overwrites the earlier.
  const cells = new Map<
    string,
    { readonly date: string; readonly state: ParseCoverageState }
  >()
  for (const { date, sha256 } of newest) {
    const month = parsed.get(date)
    const state: ParseCoverageState = failed.has(date)
      ? "failed"
      : month === undefined
        ? "not-parsed"
        : (yield* needsParse(month, sha256, source.parserVersion))
          ? "stale"
          : "parsed"
    cells.set(date.slice(0, 7), { date, state })
  }
  const first = newest.at(0)
  const last = newest.at(-1)
  if (first === undefined || last === undefined) return ParseCoverage.make([])
  const firstYear = Number(first.date.slice(0, 4))
  const lastYear = Math.max(
    Number((yield* wibDateAt(yield* DateTime.now)).slice(0, 4)),
    Number(last.date.slice(0, 4))
  )
  return ParseCoverage.make(
    Array.from({ length: lastYear - firstYear + 1 }, (_row, i) => {
      const year = firstYear + i
      return {
        year,
        months: Array.from(
          { length: 12 },
          (_, m) =>
            cells.get(`${year}-${String(m + 1).padStart(2, "0")}`) ?? null
        ),
      }
    })
  )
})
