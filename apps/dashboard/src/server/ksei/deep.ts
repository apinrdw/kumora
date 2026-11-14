// A Deep backfill's own steps, after the scheduled pass: `seed`, the seeded
// filenames still to fetch, and `probe:<kind>:<year>`, which guesses each
// missing month's period end. archive-run.ts stores what they return with
// its `report:` steps. Spec apinrdw/kumora#327, "Deep backfill".
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

import { ArchiveBucket } from "../archive/bucket.ts"
import { REPORTS_PREFIX } from "../archive/run.ts"
import { FIRST_YEAR, monthsHeld } from "./coverage.ts"
import { recordsByFilename } from "./held.ts"
import type { KseiReportKind } from "./kind.ts"
import {
  kseiFilenames,
  ListedKseiReport,
  MOST_NAMES_A_DAY,
  unlistedReport,
} from "./listing.ts"
import { WAYBACK_SEED } from "./wayback-seed.ts"

// The years a Deep backfill probes, one step per kind and year.
// Decision: FIRST_YEAR (2008) to 2023. KSEI serves files back to 2008, and
// its listings hold November 2023 onward on 2026-11-14 (a rolling three
// years), which the daily runs keep from then on. See apinrdw/kumora#324.
export const PROBE_YEARS = Array.from(
  { length: 2023 - FIRST_YEAR + 1 },
  (_, i) => FIRST_YEAR + i
)

// The calendar days a probe tries per month, from the month's last.
const PROBE_DAYS = 7

// Months probed at once in one step, out of courtesy to KSEI. Within a month
// the HEADs go one at a time, to stop at the first find.
const PROBE_CONCURRENCY = 4

// The most HEADs a probe step sends one after another: its months go
// PROBE_CONCURRENCY at once, each up to PROBE_DAYS days under every name.
export const PROBE_HEADS_IN_TURN =
  Math.ceil(12 / PROBE_CONCURRENCY) * PROBE_DAYS * MOST_NAMES_A_DAY

// The seeded filenames the archive doesn't hold, leaving out those this run
// already tried (`tried`): a step name may name one file only once.
export const seed = Effect.fnUntraced(function* (tried: ReadonlyArray<string>) {
  const held = yield* recordsByFilename()
  const skip = new Set(tried)
  const reports = yield* Effect.forEach(
    WAYBACK_SEED.filter((name) => !held.has(name) && !skip.has(name)),
    unlistedReport
  )
  return reports.filter((report) => report !== undefined)
})

const Probed = Schema.Struct({
  // At most one a month.
  found: Schema.Array(ListedKseiReport),
  // YYYY-MM, oldest first.
  notFound: Schema.Array(Schema.String),
})
export type Probed = typeof Probed.Type

// The months of `kind` the archive holds a record of, as YYYY-MM.
const heldMonths = Effect.fnUntraced(function* (kind: KseiReportKind) {
  return yield* monthsHeld(
    yield* (yield* ArchiveBucket).list(REPORTS_PREFIX),
    kind
  )
})

// The names to try for a month, newest day first, each day under every
// name: PROBE_DAYS days times the kind's names, at most 14.
const candidates = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  year: number,
  month: number
) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, "0")
  const names = yield* Effect.forEach(
    Array.from({ length: PROBE_DAYS }, (_, i) => last - i),
    (day) => kseiFilenames(kind, `${year}${mm}${String(day).padStart(2, "0")}`)
  )
  return names.flat()
})

// KSEI answered a probe with neither a file nor its "no file" redirect.
class ProbeUnanswered extends Schema.TaggedError<ProbeUnanswered>()(
  "ProbeUnanswered",
  { message: Schema.String }
) {}

// Whether KSEI serves `url`: a 2xx is a file, a 3xx (KSEI's `302 /id`) none.
// Anything else, a 4xx such as a 429 included, fails the step, whose retries
// ask again; a step that still fails is a probe failure, not a month not
// found.
const served = Effect.fnUntraced(function* (url: string) {
  const response = yield* (yield* HttpClient.HttpClient).head(url)
  if (response.status >= 200 && response.status < 300) return true
  if (response.status >= 300 && response.status < 400) return false
  return yield* new ProbeUnanswered({
    message: `KSEI answered ${response.status} to HEAD ${url}`,
  })
})

// One step's probe: for each month of `year` that `kind` still lacks, a HEAD
// to each candidate name until the first file. At most 12 months of
// PROBE_DAYS days under two names, 168 HEADs.
export const probe = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  year: number
) {
  const held = yield* heldMonths(kind)
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter(
    (month) => !held.has(`${year}-${String(month).padStart(2, "0")}`)
  )
  const answers = yield* Effect.forEach(
    months,
    Effect.fnUntraced(function* (month) {
      for (const filename of yield* candidates(kind, year, month)) {
        const report = yield* unlistedReport(filename)
        if (report !== undefined && (yield* served(report.url)))
          return { month, report }
      }
      return { month, report: undefined }
    }),
    { concurrency: PROBE_CONCURRENCY }
  )
  return Probed.make({
    found: answers.flatMap(({ report }) =>
      report === undefined ? [] : [report]
    ),
    notFound: answers.flatMap(({ month, report }) =>
      report === undefined ? [`${year}-${String(month).padStart(2, "0")}`] : []
    ),
  })
})
