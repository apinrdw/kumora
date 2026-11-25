// The parse coverage (GLOSSARY.md, "Parse coverage") of a kind a parse run
// reads, a Report kind or a KSEI report kind: each archived month's state,
// laid out year by month as the KSEI Coverage card lays out its months
// (../archive/month-grid.ts), or each archived trading day's, laid out
// month by day. Any parse run's kind has one (parse-runs.ts). Spec
// apinrdw/kumora#458, and #673, "Admin".
import { wibDateAt } from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import { monthGrid } from "../archive/month-grid.ts"
import type { NewestVersion } from "../archive/report-index.ts"
import { RunId } from "../archive/run.ts"
import { ParsedMonth, parsedMonths, staleCauses } from "./months-to-parse.ts"
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

// Each archived date of `source` as a cell, oldest first. `newest` is each
// archived date's newest version, oldest first. `lastFinished` is the kind's
// last finished parse run, whose parse failures mark dates failed.
export const parseCoverageCells = Effect.fnUntraced(function* (
  source: MonthSource,
  newest: ReadonlyArray<NewestVersion>,
  lastFinished: ParseRunResult | undefined
) {
  const parsed = yield* parsedMonths(source.tables)
  const failures = new Map(
    lastFinished?.parseFailures.map(({ date, message }) => [
      date,
      { message, run: lastFinished.id },
    ])
  )
  return yield* Effect.forEach(newest, ({ date, sha256 }) =>
    parseCoverageMonth(
      date,
      sha256,
      parsed.get(date),
      failures.get(date) ?? null,
      source.parserVersion
    )
  )
})

// The last year or month (by `length` of an ISO date) to lay out: the current
// one in WIB, or the last cell's, if later.
const lastPeriod = Effect.fnUntraced(function* (
  cells: ReadonlyArray<ParseCoverageMonth>,
  length: 4 | 7
) {
  const today = (yield* wibDateAt(yield* DateTime.now)).slice(0, length)
  const last = cells.at(-1)?.date.slice(0, length) ?? today
  return last > today ? last : today
})

// A monthly kind's cells, laid out year by month, from its first archived
// month's year through the last year; empty before any month is archived.
export const parseCoverageByMonth = Effect.fnUntraced(function* (
  cells: ReadonlyArray<ParseCoverageMonth>
) {
  const first = cells.at(0)
  if (first === undefined) return ParseCoverage.make([])
  // A cell is a month, and each kind publishes at most one report
  // a month. Should two archived dates share one, the cell shows the later:
  // `cells` is oldest first, so the later date overwrites the earlier.
  const byMonth = new Map(cells.map((cell) => [cell.date.slice(0, 7), cell]))
  return ParseCoverage.make(
    yield* monthGrid(
      Number(first.date.slice(0, 4)),
      `${yield* lastPeriod(cells, 4)}-12`,
      Effect.fnUntraced(function* (month) {
        return byMonth.get(month) ?? null
      })
    )
  )
})

// A daily kind's parse coverage (the Above-5% parse run's): a row per month,
// from its first archived day's month to the current one in WIB (or its last
// archived day's, if later), oldest first.
const DailyParseCoverage = Schema.Array(
  Schema.Struct({
    // YYYY-MM.
    month: Schema.String,
    // Its days from the 1st, each its archived trading day; null for a day
    // with no archived report, and none past the last archived day.
    days: Schema.Array(Schema.NullOr(ParseCoverageMonth)),
  })
)
type DailyParseCoverage = typeof DailyParseCoverage.Type

// A daily kind's cells, laid out month by day; empty before any day is
// archived.
export const parseCoverageByDay = Effect.fnUntraced(function* (
  cells: ReadonlyArray<ParseCoverageMonth>
) {
  const first = cells.at(0)
  if (first === undefined) return DailyParseCoverage.make([])
  const byMonth = new Map<string, Array<ParseCoverageMonth | null>>()
  for (const cell of cells) {
    const days = byMonth.get(cell.date.slice(0, 7)) ?? []
    days[Number(cell.date.slice(8, 10)) - 1] = cell
    byMonth.set(cell.date.slice(0, 7), days)
  }
  const months = (yield* monthGrid(
    Number(first.date.slice(0, 4)),
    yield* lastPeriod(cells, 7),
    Effect.succeed
  ))
    .flatMap(({ months: ofYear }) => ofYear)
    .filter((month) => month >= first.date.slice(0, 7))
  return DailyParseCoverage.make(
    months.map((month) => ({
      month,
      // Array.from fills a sparse array's holes with undefined.
      days: Array.from(byMonth.get(month) ?? [], (day) => day ?? null),
    }))
  )
})
