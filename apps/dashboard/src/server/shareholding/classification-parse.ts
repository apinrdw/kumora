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
import { newestUnparsed } from "../holdings/months-to-parse.ts"
import { kindPrefix, reportKey } from "./keys.ts"

const KIND = "investor-classification"

// A month to parse: its data date and the SHA-256 of its newest version.
const MonthToParse = Schema.Struct({
  dataDate: Schema.String,
  sha256: Schema.String,
})
type MonthToParse = typeof MonthToParse.Type

export const monthsToParse = Effect.gen(function* () {
  const months = yield* newestUnparsed(
    yield* kindPrefix(KIND),
    yield* parsedClassificationMonths,
    PARSER_VERSION
  )
  return months.map(({ date, sha256 }) =>
    MonthToParse.make({ dataDate: date, sha256 })
  )
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
