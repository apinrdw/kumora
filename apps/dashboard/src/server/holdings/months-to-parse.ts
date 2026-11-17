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
}

// The version each month in `table`, a month record table keyed by
// `dateColumn`, was parsed from.
export const parsedMonths = Effect.fnUntraced(function* (
  table: string,
  dateColumn: string
) {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT ${dateColumn} AS date, sha256, parser_version FROM ${table}`,
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
  return new Map<string, ParsedMonth>(
    months.map(({ date, sha256, parser_version }) => [
      date,
      { sha256, parserVersion: parser_version },
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

// Whether a month whose newest version is `sha256` is to be parsed: it has
// no parsed holdings, or they come from another version or parser version.
export const needsParse = Effect.fnUntraced(function* (
  month: ParsedMonth | undefined,
  sha256: string,
  parserVersion: number
) {
  return (
    month === undefined ||
    month.sha256 !== sha256 ||
    month.parserVersion !== parserVersion
  )
})

// The months under `prefix` to parse, oldest first, each with the SHA-256 of
// its newest version.
export const newestUnparsed = Effect.fnUntraced(function* (
  prefix: string,
  parsed: ReadonlyMap<string, ParsedMonth>,
  parserVersion: number
) {
  return yield* Effect.filter(
    yield* newestVersions(prefix),
    ({ date, sha256 }) => needsParse(parsed.get(date), sha256, parserVersion)
  )
})
