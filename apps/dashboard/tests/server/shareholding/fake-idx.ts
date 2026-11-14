// A fake IDX for the archive run: an HttpClient that answers the listing
// from the recorded fixture and each file from `www.idx.id` with small bytes.
// Tests change `files` (an ETag, a 404) or `listing` between runs.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import { LISTING_URL } from "@/server/shareholding/listing"

import recorded from "./fixtures/idx-listing-2026-11-14.json"

export type ListingItem = (typeof recorded.items)[number]

export interface FakeFile {
  readonly body: string
  readonly etag: string
  readonly lastModified: string
}

export interface FakeIdx {
  listing: ReadonlyArray<ListingItem>
  // Keyed by the `www.idx.id` URL a run downloads.
  readonly files: Map<string, FakeFile>
  // Every URL requested, in order.
  readonly requests: Array<string>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

export const idxIdUrl = (prospectus: string) =>
  prospectus.replace("https://www.idx.co.id/", "https://www.idx.id/")

export const fakeIdx = (
  listing: ReadonlyArray<ListingItem> = recorded.items
): FakeIdx => {
  const files = new Map(
    listing.map((item, index) => [
      idxIdUrl(item.Prospectus),
      {
        body: `xlsx bytes of ${item.Prospectus}`,
        etag: `"etag-${index}:0"`,
        lastModified: "Fri, 13 Nov 2026 10:28:42 GMT",
      },
    ])
  )
  const idx: FakeIdx = {
    listing,
    files,
    requests: [],
    layer: Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          idx.requests.push(url.href)
          if (url.href === LISTING_URL)
            return HttpClientResponse.fromWeb(
              request,
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
              : new Response(file.body, {
                  headers: {
                    "content-type":
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    etag: file.etag,
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
