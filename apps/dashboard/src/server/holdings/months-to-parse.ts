// Which archived months to parse into parsed holdings: a month is parsed
// when its newest archived version (by fetched-at) or the parser's version
// differs from the version its parsed holdings came from, or when it has
// none. Every parse run's reconcile uses it (parse-steps.ts), and so does
// the parse coverage (parse-coverage.ts).
import { Effect, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { parseRecordName } from "../archive/record-key.ts"
import { HoldingsDb } from "./db.ts"

export interface ParsedMonth {
  readonly sha256: string
  readonly parserVersion: number
  // An ISO instant.
  readonly parsedAt: string
  // The stocks its parsed holdings hold.
  readonly stockCount: number
}

// The version each month in `table`, a month record table keyed by
// `dateColumn`, was parsed from, and how many stocks `stockTable`, its
// stock table, holds for it.
export const parsedMonths = Effect.fnUntraced(function* (
  table: string,
  stockTable: string,
  dateColumn: string
) {
  const [rows = [], counts = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT ${dateColumn} AS date, sha256, parser_version, parsed_at FROM ${table}`,
      params: [],
    },
    {
      sql: `SELECT ${dateColumn} AS date, COUNT(*) AS stocks FROM ${stockTable} GROUP BY ${dateColumn}`,
      params: [],
    },
  ])
  const months = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        date: Schema.String,
        sha256: Schema.String,
        parser_version: Schema.Number,
        parsed_at: Schema.String,
      })
    )
  )(rows)
  const stocks = new Map(
    Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({ date: Schema.String, stocks: Schema.Number })
      )
    )(counts).map(({ date, stocks: count }) => [date, count])
  )
  return new Map<string, ParsedMonth>(
    months.map(({ date, sha256, parser_version, parsed_at }) => [
      date,
      {
        sha256,
        parserVersion: parser_version,
        parsedAt: parsed_at,
        stockCount: stocks.get(date) ?? 0,
      },
    ])
  )
})

// Each date archived under `prefix`, oldest first, with the SHA-256 of its
// newest version by fetched-at: the version a parse run reads. The parse
// coverage (parse-coverage.ts) reads it too, so it never disagrees with what
// the next run picks.
export const newestVersions = Effect.fnUntraced(function* (prefix: string) {
  const newest = new Map<string, { sha256: string; fetchedAt: string }>()
  for (const { key } of yield* (yield* ArchiveBucket).list(prefix)) {
    const record = yield* parseRecordName(key.slice(prefix.length))
    if (record === undefined) continue
    const { date, sha256, fetchedAt } = record
    const held = newest.get(date)
    if (held === undefined || fetchedAt > held.fetchedAt)
      newest.set(date, { sha256, fetchedAt })
  }
  return [...newest]
    .map(([date, { sha256 }]) => ({ date, sha256 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
})

// Why a month's parsed holdings are stale: its newest version is `sha256`,
// not theirs, or the parser's version is `parserVersion`, not theirs. Empty
// when neither.
export const staleCauses = (
  month: ParsedMonth,
  sha256: string,
  parserVersion: number
) => [
  ...(month.sha256 === sha256 ? [] : (["newer-version"] as const)),
  ...(month.parserVersion === parserVersion
    ? []
    : (["parser-updated"] as const)),
]

// Whether a month whose newest version is `sha256` is to be parsed: it has
// no parsed holdings, or they are stale.
const needsParse = (
  month: ParsedMonth | undefined,
  sha256: string,
  parserVersion: number
) => month === undefined || staleCauses(month, sha256, parserVersion).length > 0

// The months under `prefix` to parse, oldest first, each with the SHA-256 of
// its newest version.
export const newestUnparsed = Effect.fnUntraced(function* (
  prefix: string,
  parsed: ReadonlyMap<string, ParsedMonth>,
  parserVersion: number
) {
  return (yield* newestVersions(prefix)).filter(({ date, sha256 }) =>
    needsParse(parsed.get(date), sha256, parserVersion)
  )
})
