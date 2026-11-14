// IDX's Data Kepemilikan Saham listing, read from `www.idx.id`, which serves it
// without the Cloudflare challenge `www.idx.co.id` answers a Worker with.
// docs/research/idx-kepemilikan-listing.md (branch research/idx-kepemilikan-listing)
// has the endpoint's behaviour.
import { NonRetryable } from "@workspace/server"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

// One call returns every year: no `year`, and `length` because it defaults
// to 25.
export const LISTING_URL =
  "https://www.idx.id/primary/list/id/perusahaan-tercatat/data-kepemilikan-saham/?length=9999"

const ListingResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      Description: Schema.String,
      Prospectus: Schema.String,
      // The data date, always at T12:00:00; not when the file was published.
      ListingDate: Schema.String.check(
        Schema.isPattern(/^\d{4}-\d{2}-\d{2}T12:00:00$/)
      ),
    })
  ),
})

const ReportKind = Schema.Literals([
  "above-5",
  "above-1",
  "investor-type",
  "investor-classification",
  "other",
])
export type ReportKind = typeof ReportKind.Type

// Matched on the trimmed description, never on the hand-typed file name.
// The investor prefixes are the live listing's of 2026-11-14.
const KIND_PREFIXES: ReadonlyArray<readonly [string, ReportKind]> = [
  ["Pemegang Saham di Atas 5%", "above-5"],
  ["Pemegang Saham di Atas 1%", "above-1"],
  [
    "Data Kepemilikan Saham Perusahaan Tercatat per Tipe Investor",
    "investor-type",
  ],
  [
    "Data Kepemilikan Saham Perusahaan Tercatat Berdasarkan Klasifikasi Investor",
    "investor-classification",
  ],
]

// One listing entry, as a run keeps it between steps: plain JSON.
export const ListedReport = Schema.Struct({
  description: Schema.String,
  rawDescription: Schema.String,
  kind: ReportKind,
  // YYYY-MM-DD.
  dataDate: Schema.String,
  // The `Prospectus` URL as listed, on www.idx.co.id.
  sourceUrl: Schema.String,
  // The same file on www.idx.id, the URL a run downloads.
  fetchUrl: Schema.String,
})
export type ListedReport = typeof ListedReport.Type

const reportKind = Effect.fnUntraced(function* (description: string) {
  return (
    KIND_PREFIXES.find(([prefix]) => description.startsWith(prefix))?.[1] ??
    "other"
  )
})

// Every file is fetched from www.idx.id; www.idx.co.id never is.
const fetchUrlOf = Effect.fnUntraced(function* (sourceUrl: string) {
  const url = new URL(sourceUrl)
  url.host = "www.idx.id"
  return url.href
})

// The listing couldn't be read: an archive run fails with this message, which
// the admin page shows.
export class ListingUnreadable extends Schema.TaggedError<ListingUnreadable>()(
  "ListingUnreadable",
  { message: Schema.String }
) {}

export const fetchListing = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const { items } = yield* client.get(LISTING_URL).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ListingResponse)),
    Effect.catchTags({
      HttpClientError: ({ reason }) =>
        Effect.fail(
          new ListingUnreadable({
            message:
              reason._tag === "StatusCodeError"
                ? `The IDX listing answered ${reason.response.status} (${LISTING_URL})`
                : `The IDX listing couldn't be read: ${reason.message}`,
          })
        ),
      // IDX changed the listing: retrying won't fix it.
      SchemaError: (error) =>
        Effect.fail(
          new NonRetryable({
            message: `The IDX listing no longer matches its Schema: ${error.message}`,
          })
        ),
    })
  )
  return yield* Effect.forEach(
    items,
    Effect.fnUntraced(function* (item) {
      const description = item.Description.trim()
      return ListedReport.make({
        description,
        rawDescription: item.Description,
        kind: yield* reportKind(description),
        dataDate: item.ListingDate.slice(0, 10),
        sourceUrl: item.Prospectus,
        fetchUrl: yield* fetchUrlOf(item.Prospectus),
      })
    })
  )
})
