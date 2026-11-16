// A fake IDX for the archive run: an HttpClient that answers the listing
// from the recorded fixture and each file from `www.idx.id`: a classification
// or investor-type report with a fixture's real bytes, any other with small
// bytes.
// Tests change `files` (an ETag, a status, delete for a 404), `listing`, or
// `listingResponse` (a 403, a changed shape) between runs.
import { assert } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import { LISTING_URL } from "@/server/shareholding/listing"

import recorded from "./fixtures/idx-listing-2026-11-14.json"

export type ListingItem = (typeof recorded.items)[number]

interface FakeFile {
  readonly body: string | Uint8Array<ArrayBuffer>
  // Left out of the response when null.
  readonly etag: string | null
  // Answered to a HEAD instead of `etag`, when set.
  readonly headEtag?: string
  readonly lastModified: string
  // Answered instead of the file, when set.
  readonly status?: number
}

export interface FakeIdx {
  listing: ReadonlyArray<ListingItem>
  // Answered instead of `listing`, when set.
  listingResponse: (() => Response) | undefined
  // Keyed by the `www.idx.id` URL a run downloads.
  readonly files: Map<string, FakeFile>
  // Every URL requested, in order.
  readonly requests: Array<string>
  // The URLs requested with HEAD, in order.
  readonly heads: Array<string>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

const etagHeader = (etag: string | null): Record<string, string> =>
  etag === null ? {} : { etag }

export const idxIdUrl = (prospectus: string) =>
  prospectus.replace("https://www.idx.co.id/", "https://www.idx.id/")

// Real classification reports, trimmed to their title and header rows and the
// stocks AADI, ACRO, BBCA and WBSA (WBSA lists after March 2026), by data
// date: two of the Mar–Aug layout (May's rows carry an empty trailing cell)
// and two of the Sep 2026+ Local_/Foreign_ layout.
const CLASSIFICATION_FIXTURES = {
  "2026-03-31": "peng-03-00001-klasifikasi.xlsx",
  "2026-05-29": "peng-05-00003-klasifikasi.xlsx",
  "2026-09-30": "peng-2026-09-00026-klasifikasi.xlsx",
  "2026-10-30": "peng-2026-10-00028-klasifikasi.xlsx",
} as const
export type ClassificationFixture = keyof typeof CLASSIFICATION_FIXTURES

// Copies of the real reports, each broken one way
// (~/.t3/notes/kumora/363/break-classification-xlsx.py): October's with its
// `Total Scripless` renamed, March's naming a classification `BANKS`, May's
// with BBCA's bank holding one share past its total, September's with no
// stock rows, October's with its Foreign_Bank column named Local_Bank, and
// October's with BBCA's SHARE_CODE an error, a number, or no cell.
export type BrokenFixture =
  | "unknown-header"
  | "unknown-classification"
  | "unsummed"
  | "empty"
  | "repeated-column"
  | "error-code"
  | "numeric-code"
  | "no-code"

// October's report with BBCA's SHARE_CODE an inline string of two
// rich-text runs, which reads as the original.
export type InlineFixture = "inline-code"

// Each fixture as a base64 data URL, by path (vitest.config.ts).
const FIXTURE_FILES = import.meta.glob<string>("./fixtures/*.xlsx", {
  query: "?inline",
  import: "default",
  eager: true,
})

// A fixture's bytes, fresh for each call.
export const classificationFixture = (
  name: ClassificationFixture | BrokenFixture | InlineFixture
) => {
  const dataUrl = FIXTURE_FILES[`./fixtures/classification-${name}.xlsx`]
  assert.isDefined(dataUrl)
  return new Uint8Array(Buffer.from(dataUrl.split(",")[1] ?? "", "base64"))
}

// The listing item of a fixture's report.
export const classificationItem = (dataDate: ClassificationFixture) => {
  const item = recorded.items.find((listed) =>
    listed.Prospectus.endsWith(`/${CLASSIFICATION_FIXTURES[dataDate]}`)
  )
  assert.isDefined(item)
  return item
}

// A fake IDX that lists only the fixtures' classification reports.
export const classificationIdx = () =>
  fakeIdx(
    (Object.keys(CLASSIFICATION_FIXTURES) as Array<ClassificationFixture>).map(
      classificationItem
    )
  )

// Real investor-type reports, trimmed to their title and header rows and the
// stocks AADI, BBCA, TRUE and WBSA (WBSA lists from April 2026), by data
// date (~/.t3/notes/kumora/402/trim-investor-type-xlsx.py): Nov 2025's
// unsplit layout with blank cells, Apr 2026's split layout with blank cells,
// TRUE's code a boolean cell and empty styled cells past its header's total
// column, and Oct 2026's split layout writing no holding as 0.
// Decision: Nov 2025's holds only AADI and TRUE, neither of which
// stocks.spec.ts opens, so shareholding-admin.spec.ts's Parse now can parse
// it into the Test stage's HoldingsDb beside that spec.
const INVESTOR_TYPE_FIXTURES = {
  "2025-11-28": "peng-11-00004-tipe.xlsx",
  "2026-04-30": "peng-04-00009-tipe.xlsx",
  "2026-10-30": "peng-2026-10-00027-tipe.xlsx",
} as const
export type InvestorTypeFixture = keyof typeof INVESTOR_TYPE_FIXTURES

// Copies of the real reports, each broken one way
// (~/.t3/notes/kumora/402/break-investor-type-xlsx.py): October's with its
// `TOTAL SCRIPLESS` renamed, April's with BBCA's domestic CP one share past
// its total, November's with TRUE coded AADI, and October's with no stock
// rows.
export type BrokenInvestorTypeFixture =
  | "unknown-header"
  | "unsummed"
  | "duplicate-code"
  | "empty"

export const investorTypeFixture = (
  name: InvestorTypeFixture | BrokenInvestorTypeFixture
) => {
  const dataUrl = FIXTURE_FILES[`./fixtures/investor-type-${name}.xlsx`]
  assert.isDefined(dataUrl)
  return new Uint8Array(Buffer.from(dataUrl.split(",")[1] ?? "", "base64"))
}

export const investorTypeItem = (dataDate: InvestorTypeFixture) => {
  const item = recorded.items.find((listed) =>
    listed.Prospectus.endsWith(`/${INVESTOR_TYPE_FIXTURES[dataDate]}`)
  )
  assert.isDefined(item)
  return item
}

// The listing items of every investor-type fixture's report.
export const investorTypeItems = () =>
  (Object.keys(INVESTOR_TYPE_FIXTURES) as Array<InvestorTypeFixture>).map(
    investorTypeItem
  )

// What IDX serves at a listed URL: an investor-type report with a fixture
// its fixture's bytes, a classification report its fixture's bytes, or the
// Mar–Aug layout's May fixture for a month with none.
const fileBody = (prospectus: string) => {
  const [investorType] =
    Object.entries(INVESTOR_TYPE_FIXTURES).find(([, file]) =>
      prospectus.endsWith(`/${file}`)
    ) ?? []
  if (investorType !== undefined)
    return investorTypeFixture(investorType as InvestorTypeFixture)
  if (!prospectus.endsWith("-klasifikasi.xlsx"))
    return `xlsx bytes of ${prospectus}`
  const [dataDate = "2026-05-29"] =
    Object.entries(CLASSIFICATION_FIXTURES).find(([, file]) =>
      prospectus.endsWith(`/${file}`)
    ) ?? []
  return classificationFixture(dataDate as ClassificationFixture)
}

export const fakeIdx = (
  listing: ReadonlyArray<ListingItem> = recorded.items
): FakeIdx => {
  const files = new Map<string, FakeFile>(
    listing.map((item, index) => [
      idxIdUrl(item.Prospectus),
      {
        body: fileBody(item.Prospectus),
        etag: `"etag-${index}:0"`,
        lastModified: "Fri, 13 Nov 2026 10:28:42 GMT",
      },
    ])
  )
  const idx: FakeIdx = {
    listing,
    listingResponse: undefined,
    files,
    requests: [],
    heads: [],
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          idx.requests.push(url.href)
          if (request.method === "HEAD") idx.heads.push(url.href)
          if (url.href === LISTING_URL)
            return HttpClientResponse.fromWeb(
              request,
              idx.listingResponse?.() ??
                Response.json({
                  items: idx.listing,
                  meta: {
                    startIndex: 0,
                    pageSize: 9999,
                    pageTotal: 1,
                    search: "",
                  },
                })
            )
          const file = files.get(url.href)
          return HttpClientResponse.fromWeb(
            request,
            file === undefined
              ? new Response("Not Found", { status: 404 })
              : file.status !== undefined
                ? new Response("IDX error", { status: file.status })
                : new Response(file.body, {
                    headers: {
                      "content-type":
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      ...etagHeader(
                        request.method === "HEAD"
                          ? (file.headEtag ?? file.etag)
                          : file.etag
                      ),
                      "last-modified": file.lastModified,
                    },
                  })
          )
        })
      )
    ),
  }
  return idx
}
