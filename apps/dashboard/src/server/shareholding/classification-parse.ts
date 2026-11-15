// The archive run's reconcile: which classification months to parse, and the
// parse of one. A data date is parsed when its newest archived version (by
// fetched-at) or the parser's version differs from the version its parsed
// holdings came from, or when it has none. Spec apinrdw/kumora#363, "IDX
// archive run: the reconcile step".
import { NonRetryable } from "@workspace/server"
import { DateTime, Effect, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import {
  PARSER_VERSION,
  parseClassificationMonth,
  parsedClassificationMonths,
} from "../holdings/classification.ts"
import { kindPrefix, reportKey } from "./keys.ts"

const KIND = "investor-classification"

// A month to parse: its data date and the SHA-256 of its newest version.
const MonthToParse = Schema.Struct({
  dataDate: Schema.String,
  sha256: Schema.String,
})
type MonthToParse = typeof MonthToParse.Type

// A record's key: <prefix><data-date>/<sha256>.<fetched-at>.<listing>.json
// (keys.ts), its fetched-at an ISO instant without colons, so it sorts.
const RECORD =
  /^(\d{4}-\d{2}-\d{2})\/([0-9a-f]{64})\.([^.]+\.\d{3}Z)\.[0-9a-f]+\.json$/

export const monthsToParse = Effect.gen(function* () {
  const prefix = yield* kindPrefix(KIND)
  const newest = new Map<string, { sha256: string; fetchedAt: string }>()
  for (const { key } of yield* (yield* ArchiveBucket).list(prefix)) {
    const [, dataDate, sha256, fetchedAt] =
      RECORD.exec(key.slice(prefix.length)) ?? []
    if (
      dataDate === undefined ||
      sha256 === undefined ||
      fetchedAt === undefined
    )
      continue
    const held = newest.get(dataDate)
    if (held === undefined || fetchedAt > held.fetchedAt)
      newest.set(dataDate, { sha256, fetchedAt })
  }
  const parsed = yield* parsedClassificationMonths
  return [...newest]
    .filter(([dataDate, { sha256 }]) => {
      const month = parsed.get(dataDate)
      return (
        month === undefined ||
        month.sha256 !== sha256 ||
        month.parserVersion !== PARSER_VERSION
      )
    })
    .map(([dataDate, { sha256 }]) => MonthToParse.make({ dataDate, sha256 }))
    .sort((a, b) => (a.dataDate < b.dataDate ? -1 : 1))
})

// Parses one month's archived version into parsed holdings. A file the
// reader can't read fails without retries: its bytes won't change.
export const parseMonth = Effect.fnUntraced(function* ({
  dataDate,
  sha256,
}: MonthToParse) {
  const key = yield* reportKey(KIND, dataDate, sha256)
  const bytes = yield* (yield* ArchiveBucket).getBytes(key)
  if (bytes === undefined)
    return yield* new NonRetryable({ message: `The archive has no ${key}` })
  const stocks = yield* parseClassificationMonth(
    dataDate,
    sha256,
    bytes,
    DateTime.formatIso(yield* DateTime.now)
  ).pipe(
    Effect.catchTags({
      XlsxUnreadable: ({ message }) =>
        Effect.fail(new NonRetryable({ message: `${key}: ${message}` })),
      ClassificationUnreadable: ({ message }) =>
        Effect.fail(new NonRetryable({ message: `${key}: ${message}` })),
    })
  )
  return { dataDate, stocks }
})
