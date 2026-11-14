// A fake IDX for the archive run: an HttpClient that answers the listing
// from the recorded fixture and each file from `www.idx.id` with small bytes.
// Tests change `files` (an ETag, a status, delete for a 404), `listing`, or
// `listingResponse` (a 403, a changed shape) between runs.
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import { LISTING_URL } from "@/server/shareholding/listing"

import recorded from "./fixtures/idx-listing-2026-11-14.json"

export type ListingItem = (typeof recorded.items)[number]

export interface FakeFile {
  readonly body: string
  readonly etag: string
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
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

export const idxIdUrl = (prospectus: string) =>
  prospectus.replace("https://www.idx.co.id/", "https://www.idx.id/")

export const fakeIdx = (
  listing: ReadonlyArray<ListingItem> = recorded.items
): FakeIdx => {
  const files = new Map<string, FakeFile>(
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
    listingResponse: undefined,
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
