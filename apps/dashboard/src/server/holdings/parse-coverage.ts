// The parse coverage (GLOSSARY.md, "Parse coverage") of a kind a parse run
// reads, a Report kind or a KSEI report kind: each archived month's state,
// laid out year by month as the KSEI Coverage card lays out its months
// (../archive/month-grid.ts). Any parse run's kind has one (parse-runs.ts).
// Spec apinrdw/kumora#458.
import { wibDateAt } from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import { monthGrid } from "../archive/month-grid.ts"
import { RunId } from "../archive/run.ts"
import {
  newestVersions,
  ParsedMonth,
  parsedMonths,
  staleCauses,
} from "./months-to-parse.ts"
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
export type ParseCoverageState = typeof ParseCoverageState.Type

const StaleCause = Schema.Literals(["newer-version", "parser-updated"])
export type StaleCause = typeof StaleCause.Type

// An archived month, as a cell of the grid and its detail panel.
const ParseCoverageMonth = Schema.Struct({
  // The archived date the cell shows.
  date: Schema.String,
  state: ParseCoverageState,
  // The SHA-256 of its newest archived version: what a parse run reads.
  newestSha256: Schema.String,
  // Its parsed holdings, null when it has none.
  parsed: Schema.NullOr(ParsedMonth),
  // Why its parsed holdings are stale; empty when they aren't, or it has
  // none.
  staleCauses: Schema.Array(StaleCause),
  // Its parse failure in the last finished parse run, null when it had
  // none.
  failure: Schema.NullOr(Schema.Struct({ message: Schema.String, run: RunId })),
})
export type ParseCoverageMonth = typeof ParseCoverageMonth.Type

const ParseCoverage = Schema.Array(
  Schema.Struct({
    year: Schema.Number,
    // January to December; null for a month with no archived report.
    months: Schema.Array(Schema.NullOr(ParseCoverageMonth)),
  })
)
export type ParseCoverage = typeof ParseCoverage.Type

// The month archived at `date`, whose newest version is `sha256`.
const parseCoverageMonth = Effect.fnUntraced(function* (
  date: string,
  sha256: string,
  month: ParsedMonth | undefined,
  failure: ParseCoverageMonth["failure"],
  parserVersion: number
) {
  const causes =
    month === undefined ? [] : yield* staleCauses(month, sha256, parserVersion)
  return ParseCoverageMonth.make({
    date,
    state:
      failure !== null
        ? "failed"
        : month === undefined
          ? "not-parsed"
          : causes.length > 0
            ? "stale"
            : "parsed",
    newestSha256: sha256,
    parsed: month ?? null,
    staleCauses: causes,
    failure,
  })
})

// `source`'s parse coverage, from its first archived month's year to the
// current one in WIB (or its last archived month's, if later); empty before
// any month is archived. `lastFinished` is the kind's last finished parse
// run, whose parse failures mark months failed.
export const parseCoverage = Effect.fnUntraced(function* (
  source: MonthSource,
  lastFinished: ParseRunResult | undefined
) {
  const newest = yield* newestVersions(yield* source.prefix)
  const parsed = yield* parsedMonths(source.tables)
  const failures = new Map(
    lastFinished?.parseFailures.map(({ date, message }) => [
      date,
      { message, run: lastFinished.id },
    ])
  )
  // Decision: a cell is a month, and each kind publishes at most one report
  // a month. Should two archived dates share one, the cell shows the later:
  // `newest` is oldest first, so the later date overwrites the earlier.
  const cells = new Map<string, ParseCoverageMonth>()
  for (const { date, sha256 } of newest)
    cells.set(
      date.slice(0, 7),
      yield* parseCoverageMonth(
        date,
        sha256,
        parsed.get(date),
        failures.get(date) ?? null,
        source.parserVersion
      )
    )
  const first = newest.at(0)
  const last = newest.at(-1)
  if (first === undefined || last === undefined) return ParseCoverage.make([])
  const lastYear = Math.max(
    Number((yield* wibDateAt(yield* DateTime.now)).slice(0, 4)),
    Number(last.date.slice(0, 4))
  )
  return ParseCoverage.make(
    yield* monthGrid(
      Number(first.date.slice(0, 4)),
      `${lastYear}-12`,
      Effect.fnUntraced(function* (month) {
        return cells.get(month) ?? null
      })
    )
  )
})
