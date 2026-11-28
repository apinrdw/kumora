// Stall records (the glossary's Stall record): each stall of an Ajaib
// walk, kept after it ends, since its stall cause shows on the Broker codes
// card only while it lasts. 2026-11-27: a 2.5-minute pause of the tape walk's
// second pass left no trace of its cause. Copy diagnostics lists them.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { StallKind, WalkPass } from "./run-queue.ts"

// The last this many stalls are kept, the oldest dropped first.
const KEPT = 50

// Where a walk call is: the day, and the tape walk's pass, page and the
// pass's pages, or the Done Details walk's code, pass and page. Neither
// while it waits for Ajaib's close.
const StallPlace = Schema.Struct({
  day: WibDate,
  pass: Schema.optionalKey(WalkPass),
  code: Schema.optionalKey(StockCode),
  page: Schema.optionalKey(Schema.Finite),
  pages: Schema.optionalKey(Schema.Finite),
})
export type StallPlace = typeof StallPlace.Type

// One stall: from when its first failed call was sent to when a call answered, or the
// end of the walk (epoch ms); `ended` is null while it lasts, or when the
// worker stopped mid-stall. Its last failure's kind, the failures in a row,
// whether the walk token changed since the first, each kind's count, and the
// Ajaib tab's reloads meanwhile. Never a token, a header or a path.
const StallRecord = Schema.Struct({
  began: Schema.Finite,
  ended: Schema.NullOr(Schema.Finite),
  walk: Schema.Literals(["tape", "done-details"]),
  ...StallPlace.fields,
  kind: StallKind,
  failures: Schema.Finite,
  tokenChanged: Schema.Boolean,
  kinds: Schema.Struct({
    "refused-token": Schema.Finite,
    "no-answer": Schema.Finite,
    timeout: Schema.Finite,
  }),
  reloads: Schema.Finite,
})
export type StallRecord = typeof StallRecord.Type
export const StallRecords = Schema.Array(StallRecord)

// `record` in `records`: in place of the same stall's earlier write, else
// last, keeping the last KEPT.
export const withStallRecord = (
  records: ReadonlyArray<StallRecord>,
  record: StallRecord
) => {
  const same = (each: StallRecord) =>
    each.walk === record.walk && each.began === record.began
  const kept = records.some(same)
    ? records.map((each) => (same(each) ? record : each))
    : [...records, record]
  return kept.slice(-KEPT)
}

// One stall as a line of Copy diagnostics: when, which walk where, and why.
export const stallRecordLine = Effect.fnUntraced(function* (
  record: StallRecord
) {
  const iso = (ms: number) => new Date(ms).toISOString()
  const ended = record.ended === null ? "open" : iso(record.ended)
  const where = [
    record.pass === undefined ? [] : [`${record.pass} pass`],
    record.code === undefined ? [] : [record.code],
    record.page === undefined
      ? []
      : [
          record.pages === undefined
            ? `page ${record.page}`
            : `page ${record.page} of ${record.pages}`,
        ],
  ].flat()
  const kinds = Object.entries(record.kinds)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ")
  const token = record.tokenChanged ? "token changed" : "token unchanged"
  return yield* Effect.succeed(
    [
      `${iso(record.began)} to ${ended}`,
      `${record.walk} ${record.day}${where.length === 0 ? "" : ` ${where.join(" ")}`}`,
      `last ${record.kind}, ${record.failures} failed in a row (${kinds}), ${token}, ${record.reloads} reloads`,
    ].join(" | ")
  )
})
