// Which archived months to parse into parsed holdings: a month is parsed
// when its newest archived version (by fetched-at) or the parser's version
// differs from the version its parsed holdings came from, or when it has
// none. Every parse run's reconcile uses it (parse-steps.ts); the parse
// coverage (parse-coverage.ts) shows the same states, from the report index.
import { Effect, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { parseRecordName } from "../archive/record-key.ts"
import { HoldingsDb } from "./db.ts"

// The parsed holdings tables of a kind a parse run reads, a Report kind or a
// KSEI report kind: its month record table, keyed by `dateColumn`, and its
// stock table.
export interface MonthTables {
  readonly month: string
  readonly stock: string
  readonly dateColumn: string
}

// The version a month's parsed holdings came from.
const ParsedVersion = Schema.Struct({
  sha256: Schema.String,
  parserVersion: Schema.Number,
})
type ParsedVersion = typeof ParsedVersion.Type

// A month's parsed holdings, as the parse coverage shows them.
export const ParsedMonth = Schema.Struct({
  ...ParsedVersion.fields,
  // An ISO instant.
  parsedAt: Schema.String,
  // The stocks its parsed holdings hold.
  stockCount: Schema.Number,
})
export type ParsedMonth = typeof ParsedMonth.Type

// The version each parsed month came from, by date: all reconcile reads.
export const parsedVersions = Effect.fnUntraced(function* ({
  month,
  dateColumn,
}: MonthTables) {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT ${dateColumn} AS date, sha256, parser_version FROM ${month}`,
      params: [],
    },
  ])
  const months = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        date: Schema.String,
        sha256: Schema.String,
        parser_version: Schema.Number,
      })
    )
  )(rows)
  return new Map<string, ParsedVersion>(
    months.map(({ date, sha256, parser_version }) => [
      date,
      { sha256, parserVersion: parser_version },
    ])
  )
})

// Each parsed month, by date, with when it was parsed and how many stocks
// its stock table holds for it, in one batch: what the parse coverage reads.
export const parsedMonths = Effect.fnUntraced(function* ({
  month,
  stock,
  dateColumn,
}: MonthTables) {
  const [rows = [], counts = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT ${dateColumn} AS date, sha256, parser_version, parsed_at FROM ${month}`,
      params: [],
    },
    {
      sql: `SELECT ${dateColumn} AS date, COUNT(*) AS stocks FROM ${stock} GROUP BY ${dateColumn}`,
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
      ParsedMonth.make({
        sha256,
        parserVersion: parser_version,
        parsedAt: parsed_at,
        stockCount: stocks.get(date) ?? 0,
      }),
    ])
  )
})

// Each date archived under `prefix`, oldest first, with the SHA-256 of its
// newest version by fetched-at: the version a parse run reads. The parse
// coverage reads the same from the report index (newestVersions in
// ../archive/report-index.ts), so it agrees with what the next run picks.
// The parse coverage tests hold the two to the same pick, a tie included.
const newestVersions = Effect.fnUntraced(function* (prefix: string) {
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
export const staleCauses = Effect.fnUntraced(function* (
  month: ParsedVersion,
  sha256: string,
  parserVersion: number
) {
  return [
    ...(month.sha256 === sha256 ? [] : (["newer-version"] as const)),
    ...(month.parserVersion === parserVersion
      ? []
      : (["parser-updated"] as const)),
  ]
})

// Whether a month whose newest version is `sha256` is to be parsed: it has
// no parsed holdings, or they are stale.
const needsParse = Effect.fnUntraced(function* (
  month: ParsedVersion | undefined,
  sha256: string,
  parserVersion: number
) {
  return (
    month === undefined ||
    (yield* staleCauses(month, sha256, parserVersion)).length > 0
  )
})

// The months under `prefix` to parse, oldest first, each with the SHA-256 of
// its newest version.
export const newestUnparsed = Effect.fnUntraced(function* (
  prefix: string,
  parsed: ReadonlyMap<string, ParsedVersion>,
  parserVersion: number
) {
  return yield* Effect.filter(
    yield* newestVersions(prefix),
    ({ date, sha256 }) => needsParse(parsed.get(date), sha256, parserVersion)
  )
})
