// A fake KSEI for the KSEI archive run: a `fetch` behind the archive's own
// HTTP layer (kseiHttp), so a test sees the options every request carries.
// It answers both listings from the recorded fixtures, each listed file at its
// URL with small zip bytes and KSEI's headers (the ETag is the MD5 of the
// bytes), and `302 Location: /id` for anything else, as ksei.co.id does.
// Tests change `files` (a body, an ETag, a status, delete for a 302),
// `listings`, or `listingResponse` (a 405, a changed shape) between runs.
import { assert } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { createHash } from "node:crypto"

import { kseiHttp } from "@/server/ksei/http"
import type { KseiReportKind } from "@/server/ksei/kind"
import { LISTING_URLS } from "@/server/ksei/listing"

import securitiesHoldings from "./fixtures/securities-ownerships-2026-11-14.json"
import securitiesStatistics from "./fixtures/static-stocks-2026-11-14.json"

export type ListingEntry = (typeof securitiesStatistics.data)[number]

interface FakeFile {
  readonly body: string | Uint8Array<ArrayBuffer>
  // Left out of the response when null.
  readonly etag: string | null
  readonly lastModified: string
  // Answered instead of the file, when set: a 3xx carries Location: /id.
  readonly status?: number
}

export interface FakeRequest {
  readonly url: string
  readonly method: string
  readonly cache: RequestCache | undefined
  readonly redirect: RequestRedirect | undefined
  readonly accept: string | null
}

export interface FakeKsei {
  readonly listings: Record<KseiReportKind, Array<ListingEntry>>
  // Answered instead of a kind's listing, when set.
  readonly listingResponse: Partial<Record<KseiReportKind, () => Response>>
  // Keyed by URL.
  readonly files: Map<string, FakeFile>
  readonly requests: Array<FakeRequest>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

export const RECORDED: Record<KseiReportKind, ReadonlyArray<ListingEntry>> = {
  "securities-statistics": securitiesStatistics.data,
  "securities-holdings": securitiesHoldings.data,
}

// A zip's bytes start with PK\x03\x04.
export const zipBody = (text: string) => `PK\u0003\u0004${text}`

export const md5 = (body: string | Uint8Array) =>
  createHash("md5").update(body).digest("hex")

// KSEI's ETag: the MD5 of the bytes, quoted.
export const etagOf = (body: string | Uint8Array) => `"${md5(body)}"`

export const LAST_MODIFIED = "Mon, 02 Nov 2026 00:09:49 GMT"

export const fileOf = (body: FakeFile["body"]): FakeFile => ({
  body,
  etag: etagOf(body),
  lastModified: LAST_MODIFIED,
})

const listingOf = (entries: ReadonlyArray<ListingEntry>) => ({
  data: entries,
  links: { first: null, last: null, prev: null, next: null },
  meta: {
    current_page: 1,
    from: 1,
    last_page: 1,
    per_page: 100,
    to: entries.length,
    total: entries.length,
  },
})

export const fakeKsei = (): FakeKsei => {
  const listings = {
    "securities-statistics": [...RECORDED["securities-statistics"]],
    "securities-holdings": [...RECORDED["securities-holdings"]],
  }
  const files = new Map<string, FakeFile>(
    Object.values(listings)
      .flat()
      .flatMap((entry) => entry.pdf_en)
      .map(({ url, filename }) => [url, fileOf(zipBody(`text of ${filename}`))])
  )
  const answer = (url: string, method: string): Response => {
    for (const [kind, listingUrl] of Object.entries(LISTING_URLS) as Array<
      [KseiReportKind, string]
    >)
      if (url === listingUrl)
        return (
          ksei.listingResponse[kind]?.() ??
          Response.json(listingOf(ksei.listings[kind]))
        )
    const file = files.get(url)
    if (file === undefined || (file.status ?? 200) >= 300)
      return file?.status !== undefined && file.status >= 400
        ? new Response("KSEI error", { status: file.status })
        : new Response(null, { status: 302, headers: { location: "/id" } })
    return new Response(method === "HEAD" ? null : file.body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(
          typeof file.body === "string"
            ? new TextEncoder().encode(file.body).length
            : file.body.length
        ),
        "last-modified": file.lastModified,
        ...(file.etag === null ? {} : { etag: file.etag }),
      },
    })
  }
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Effect.runPromise(
      Effect.sync(() => {
        const url = input instanceof Request ? input.url : String(input)
        const method = init?.method ?? "GET"
        ksei.requests.push({
          url,
          method,
          cache: init?.cache,
          redirect: init?.redirect,
          accept: new Headers(init?.headers).get("accept"),
        })
        return answer(url, method)
      })
    )) as typeof globalThis.fetch
  const ksei: FakeKsei = {
    listings,
    listingResponse: {},
    files,
    requests: [],
    layer: kseiHttp.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
    ),
  }
  return ksei
}

// Real Securities holdings reports, trimmed to the header and the equities AADI,
// ACRO, APOL (unpriced: in KSEI's report, not in IDX's classification report),
// BBCA and WBSA, a government bond and, in October, a warrant. May, then
// August to October: June and July are a gap.
const HOLDINGS_FIXTURES = [
  "BalanceposEfek20260529.zip",
  "BalanceposEfek20260831.zip",
  "BalanceposEfek20260930.zip",
  "BalanceposEfek20261030.zip",
] as const
export type HoldingsFixture = (typeof HOLDINGS_FIXTURES)[number]

// October's file broken three ways: Local IS and Local CP swapped in the
// header, BBCA's local ID one share over its local Total, and no EQUITY row.
export type BrokenHoldingsFixture =
  | "BalanceposEfek20261030-header.zip"
  | "BalanceposEfek20261030-sum.zip"
  | "BalanceposEfek20261030-no-equity.zip"

// Each fixture as a base64 data URL, by path (vitest.config.ts).
const FIXTURE_FILES = import.meta.glob<string>("./fixtures/**/*.zip", {
  query: "?inline",
  import: "default",
  eager: true,
})

// A fixture's bytes, fresh for each call.
export const holdingsFixture = (
  filename: HoldingsFixture | BrokenHoldingsFixture
) => {
  const dataUrl =
    FIXTURE_FILES[`./fixtures/${filename}`] ??
    FIXTURE_FILES[`./fixtures/broken/${filename}`]
  assert.isDefined(dataUrl)
  return new Uint8Array(Buffer.from(dataUrl.split(",")[1] ?? "", "base64"))
}

export const holdingsUrl = (filename: HoldingsFixture) =>
  `https://www.ksei.co.id/storage/Download/${filename}`

// A fake KSEI that lists only the fixtures' Securities holdings reports, each
// serving its fixture's bytes, and no Statistik Efek file.
export const holdingsKsei = () => {
  const ksei = fakeKsei()
  ksei.listings["securities-statistics"].length = 0
  const holdings = ksei.listings["securities-holdings"]
  holdings.splice(
    0,
    holdings.length,
    ...holdings.filter(({ pdf_en: [{ filename }] }) =>
      (HOLDINGS_FIXTURES as ReadonlyArray<string>).includes(filename)
    )
  )
  assert.strictEqual(holdings.length, HOLDINGS_FIXTURES.length)
  for (const filename of HOLDINGS_FIXTURES)
    ksei.files.set(holdingsUrl(filename), fileOf(holdingsFixture(filename)))
  return ksei
}
