// KSEI's two listings, Statistik Efek and Kepemilikan Efek, read from the
// JSON API www.ksei.co.id serves its pages from (spec apinrdw/kumora#327,
// "Fetching from KSEI"). docs/research/ksei-statistik-kepemilikan-listing.md
// has the API's behaviour.
import { jsonBytes, STEP_RESULT_BYTES } from "@workspace/server"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

import { readCapped } from "../archive/capped-body.ts"
import { KIND_LABEL, KseiReportKind } from "./kind.ts"

// One call returns a whole listing: `page[size]` defaults to 30, and KSEI
// lists 36 per kind.
// Decision: no `locale` or `append`, so an entry names its file `pdf_en`, as
// in the recorded fixtures. `pdf_id` needs `locale=id&append=pdf_id` and
// names the same file URLs; only `name` changes language. The Schema pins
// `pdf_en`, so a renamed field fails the listing instead of reading no
// files. See apinrdw/kumora#327.
export const LISTING_URLS: Record<KseiReportKind, string> = {
  "securities-statistics":
    "https://www.ksei.co.id/api/static_stocks?page[size]=100",
  "securities-holdings":
    "https://www.ksei.co.id/api/securities_ownerships?page[size]=100",
}

// Each kind's filename: its prefix, the period end as YYYYMMDD, then one of
// its suffixes, today's first. Before 2009, Kepemilikan Efek files were
// `.txt.zip`.
const FILENAME_SHAPE: Record<
  KseiReportKind,
  { readonly prefix: string; readonly suffixes: ReadonlyArray<string> }
> = {
  "securities-statistics": { prefix: "StatisEfek", suffixes: [".txt.zip"] },
  "securities-holdings": {
    prefix: "BalanceposEfek",
    suffixes: [".zip", ".txt.zip"],
  },
}

const SHAPES = KseiReportKind.literals.map((kind) => ({
  kind,
  ...FILENAME_SHAPE[kind],
}))

// A filename of any kind's prefix and any kind's suffix. A filename names
// its keys in R2, so nothing else passes. scripts/ksei-wayback-seed.mts
// repeats it for the seed it writes.
const PREFIXES = SHAPES.map(({ prefix }) => prefix).join("|")
const SUFFIXES = [...new Set(SHAPES.flatMap(({ suffixes }) => suffixes))]
  .map((suffix) => suffix.replaceAll(".", "\\."))
  .join("|")
const KSEI_FILENAME = new RegExp(
  `^(${PREFIXES})(\\d{4})(\\d{2})(\\d{2})(?:${SUFFIXES})$`
)

// A KSEI report's filename: at most 30 characters, fit for a step name and
// an R2 key.
export const KseiFilename = Schema.String.check(
  Schema.isPattern(KSEI_FILENAME)
).pipe(Schema.brand("KseiFilename"))

// Every file KSEI lists is under this origin; a run fetches nothing else.
const KSEI_ORIGIN = "https://www.ksei.co.id/"

const ListingEntry = Schema.Struct({
  // The period end's date, at the time of the request: not a publish time.
  date: Schema.String,
  name: Schema.String,
  pdf_en: Schema.Tuple([
    Schema.Struct({
      url: Schema.String.check(
        Schema.isStartingWith(KSEI_ORIGIN),
        Schema.isMaxLength(512)
      ),
      filename: KseiFilename,
    }),
  ]),
})

const ListingResponse = Schema.Struct({
  // Each entry is kept as KSEI returned it, in its record's `listing`.
  data: Schema.Array(Schema.Json),
  meta: Schema.Struct({ total: Schema.Number }),
})

// One listed file, as a run keeps it between steps: plain JSON.
export const ListedKseiReport = Schema.Struct({
  kind: KseiReportKind,
  // YYYY-MM-DD, from the filename.
  periodEnd: Schema.String,
  filename: KseiFilename,
  // The URL listed, which a run fetches.
  url: Schema.String,
  // The listing's entry as returned.
  listing: Schema.Json,
})
export type ListedKseiReport = typeof ListedKseiReport.Type

// The most bytes a listed file may take as JSON. The recorded ones take
// ~420.
export const MAX_LISTED_REPORT_BYTES = 1024

// Room in a step result for what doesn't grow with the listings.
const FIXED_RESULT_BYTES = 4096

// The most files one listing may hold; past it, that listing is unreadable.
// `plan`'s result holds both listings' files.
// Decision: 510 a kind, what fits `plan`'s result at MAX_LISTED_REPORT_BYTES
// each. KSEI lists 36 a kind on 2026-11-14, a rolling three years, so it
// stays far below. See apinrdw/kumora#327.
export const MAX_LISTED_REPORTS = Math.floor(
  (STEP_RESULT_BYTES - FIXED_RESULT_BYTES) / (2 * MAX_LISTED_REPORT_BYTES)
)

// The most bytes a listing's response may take, refused before it decodes:
// an entry takes fewer bytes in the response than in its ListedKseiReport.
// The listing of 2026-11-14 takes 8.4 KB.
export const MAX_LISTING_BYTES = MAX_LISTED_REPORTS * MAX_LISTED_REPORT_BYTES

// A listing couldn't be read: the run skips its kind and records this.
class ListingUnreadable extends Schema.TaggedError<ListingUnreadable>()(
  "ListingUnreadable",
  { kind: KseiReportKind, message: Schema.String }
) {}

// YYYY-MM-DD from a filename KseiFilename passed.
const periodEndOf = Effect.fnUntraced(function* (filename: string) {
  const [, , year, month, day] = KSEI_FILENAME.exec(filename) ?? []
  return `${year}-${month}-${day}`
})

// Where KSEI serves every file today, the unlisted ones too.
const KSEI_DOWNLOAD = `${KSEI_ORIGIN}storage/Download/`

// The kind each filename prefix names.
const KIND_OF_PREFIX: Partial<Record<string, KseiReportKind>> =
  Object.fromEntries(SHAPES.map(({ kind, prefix }) => [prefix, kind]))

// Every name `kind` has had for the period end `yyyymmdd`, today's first.
export const kseiFilenames = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  yyyymmdd: string
) {
  const { prefix, suffixes } = FILENAME_SHAPE[kind]
  return suffixes.map((suffix) =>
    KseiFilename.make(`${prefix}${yyyymmdd}${suffix}`)
  )
})

// A file no listing names, as a Deep backfill fetches it: its kind from its
// filename's prefix, at KSEI_DOWNLOAD, with `listing: null`. Undefined for a
// name that isn't a KSEI report's.
export const unlistedReport = Effect.fnUntraced(function* (filename: string) {
  const [, prefix = "", year, month, day] = KSEI_FILENAME.exec(filename) ?? []
  const kind = KIND_OF_PREFIX[prefix]
  if (kind === undefined) return undefined
  return ListedKseiReport.make({
    kind,
    periodEnd: `${year}-${month}-${day}`,
    filename: KseiFilename.make(filename),
    url: `${KSEI_DOWNLOAD}${filename}`,
    listing: null,
  })
})

const decodeEntry = Schema.decodeUnknownEffect(ListingEntry)

export const fetchListing = Effect.fnUntraced(function* (kind: KseiReportKind) {
  const url = LISTING_URLS[kind]
  const what = `KSEI's ${KIND_LABEL[kind]} listing`
  const unreadable = (message: string) =>
    new ListingUnreadable({ kind, message: `${what} ${message}` })
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const body = yield* client
    .get(url, { headers: { accept: "application/json" } })
    .pipe(
      Effect.flatMap((response) =>
        readCapped(response, MAX_LISTING_BYTES, what)
      ),
      Effect.flatMap((bytes) =>
        Effect.try({
          try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
          catch: () => unreadable("isn't JSON"),
        })
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(ListingResponse)),
      Effect.catchTags({
        HttpClientError: ({ reason }) =>
          Effect.fail(
            unreadable(
              reason._tag === "StatusCodeError"
                ? `answered ${reason.response.status} (${url})`
                : `couldn't be read: ${reason.message}`
            )
          ),
        NonRetryable: ({ message }) => Effect.fail(unreadable(message)),
        SchemaError: (error) =>
          Effect.fail(
            unreadable(`no longer matches its Schema: ${error.message}`)
          ),
      })
    )
  if (body.data.length !== body.meta.total)
    return yield* unreadable(
      `holds ${body.data.length} KSEI reports of the ${body.meta.total} its meta.total counts`
    )
  if (body.data.length > MAX_LISTED_REPORTS)
    return yield* unreadable(
      `holds ${body.data.length} KSEI reports, more than the ${MAX_LISTED_REPORTS} a run can carry`
    )
  const reports = yield* Effect.forEach(
    body.data,
    Effect.fnUntraced(function* (listing) {
      const entry = yield* decodeEntry(listing).pipe(
        Effect.mapError((error) =>
          unreadable(`no longer matches its Schema: ${error.message}`)
        )
      )
      const [{ url: fileUrl, filename }] = entry.pdf_en
      const report = ListedKseiReport.make({
        kind,
        periodEnd: yield* periodEndOf(filename),
        filename,
        url: fileUrl,
        listing,
      })
      if ((yield* jsonBytes(report)) > MAX_LISTED_REPORT_BYTES)
        return yield* unreadable(
          `has an entry over ${MAX_LISTED_REPORT_BYTES} bytes: ${filename}`
        )
      return report
    })
  )
  // A filename listed twice is one file.
  return [
    ...new Map(reports.map((report) => [report.filename, report])).values(),
  ]
})
