// A fake IDX for the disclosure run: a `fetch` behind the run's own HTTP
// layer (disclosureHttp), answering GetAnnouncement on www.idx.id for a day
// and language from `versions`, a page at a time, and each attachment at its
// www.idx.id path from `files`. Anything else answers 404, as www.idx.id
// does for a missing file. Tests add versions (`published`), change `files`
// (a status, a body) or set `listingResponse` (a 500, a changed shape)
// between runs, and read `requests`.
import { Effect, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"

import { disclosureHttp } from "@/server/disclosures/http"
import type { DisclosureLanguage } from "@/server/disclosures/key"

import recordedEn from "./fixtures/announcements-2026-11-24-en.json"
import recordedId from "./fixtures/announcements-2026-11-24-id.json"

const STATIC = "/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/From_EREP"

// One reply of GetAnnouncement, in IDX's shape (probed 2026-11-26).
export interface Reply {
  readonly pengumuman: Record<string, unknown> & {
    readonly Id2: string
    readonly TglPengumuman: string
  }
  readonly attachments: ReadonlyArray<Record<string, unknown>>
}

interface FakeFile {
  readonly body: string
  // Answered instead of the file, when set.
  readonly status?: number
}

export interface FakeIdx {
  readonly versions: Record<DisclosureLanguage, Array<Reply>>
  // Answered instead of a listing page, when set and it answers one for
  // the page's URL.
  listingResponse: ((url: URL) => Response | undefined) | undefined
  // Keyed by path, as /StaticData/…/x.pdf.
  readonly files: Map<string, FakeFile>
  // Every URL requested, in order.
  readonly requests: Array<string>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

// A disclosure as IDX lists it: published at `stamp` (YYYYMMDDHHmmss, WIB)
// with number `number`, listing `files` (names under STATIC).
export interface Published {
  readonly stamp: string
  readonly number: string
  readonly files: ReadonlyArray<string>
  readonly title?: string
}

export const pathOf = (file: string) => `${STATIC}/${file}`

export const keyOf = ({ stamp, number }: Published) => `${stamp}-${number}`

const SUFFIX: Record<DisclosureLanguage, string> = {
  id: "_id-id",
  en: "_en-us",
}

export const replyOf = (
  published: Published,
  language: DisclosureLanguage
): Reply => {
  const { stamp } = published
  const at = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`
  return {
    pengumuman: {
      Id2: `${keyOf(published)}${SUFFIX[language]}`,
      Id: 0,
      NoPengumuman: published.number,
      TglPengumuman: at,
      JudulPengumuman:
        published.title ??
        (language === "id" ? "Laporan Bulanan" : "Monthly Report"),
      JenisPengumuman: "STOCK",
      Kode_Emiten: "BBCA      ",
      CreatedDate: at,
    },
    attachments: published.files.map((file, index) => ({
      Id: 0,
      PDFFilename: file,
      FullSavePath: `https://www.idx.co.id${pathOf(file)}`,
      IsAttachment: index > 0,
      OriginalFilename: file,
    })),
  }
}

// What a file at `path` holds in the fake.
export const bodyOf = (path: string) => `%PDF-1.4 ${path}`

const ANNOUNCEMENTS = "https://www.idx.id/primary/ListedCompany/GetAnnouncement"

const compactDay = (at: string) => at.slice(0, 10).replaceAll("-", "")

export const fakeIdx = (): FakeIdx => {
  const answer = (url: URL): Response => {
    if (`${url.origin}${url.pathname}` === ANNOUNCEMENTS) {
      const instead = idx.listingResponse?.(url)
      if (instead !== undefined) return instead
      const language = url.searchParams.get("lang") as DisclosureLanguage
      const from = url.searchParams.get("dateFrom") ?? ""
      const to = url.searchParams.get("dateTo") ?? ""
      const listed = idx.versions[language].filter(
        ({ pengumuman }) =>
          compactDay(pengumuman.TglPengumuman) >= from &&
          compactDay(pengumuman.TglPengumuman) <= to
      )
      const index = Number(url.searchParams.get("indexFrom"))
      const size = Number(url.searchParams.get("pageSize"))
      return Response.json({
        ResultCount: listed.length,
        SearchParams: {},
        Replies: listed.slice(index, index + size),
      })
    }
    const file =
      url.host === "www.idx.id" ? idx.files.get(url.pathname) : undefined
    if (file === undefined || (file.status ?? 200) >= 300)
      return new Response("<!DOCTYPE html>", {
        status: file?.status ?? 404,
        headers: { "content-type": "text/html" },
      })
    return new Response(file.body, {
      headers: { "content-type": "application/pdf" },
    })
  }
  const fetch = ((input: RequestInfo | URL) =>
    Effect.runPromise(
      Effect.sync(() => {
        const url = input instanceof Request ? input.url : String(input)
        idx.requests.push(url)
        return answer(new URL(url))
      })
    )) as typeof globalThis.fetch
  const idx: FakeIdx = {
    versions: { id: [], en: [] },
    listingResponse: undefined,
    files: new Map(),
    requests: [],
    layer: disclosureHttp.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
    ),
  }
  return idx
}

// Lists `published` in `languages`, and serves each of its files.
export const publish = (
  idx: FakeIdx,
  published: Published,
  languages: ReadonlyArray<DisclosureLanguage> = ["id", "en"]
) => {
  for (const language of languages)
    idx.versions[language].push(replyOf(published, language))
  for (const file of published.files)
    idx.files.set(pathOf(file), { body: bodyOf(pathOf(file)) })
}

// The file requests a test's runs sent, by path.
export const fileRequests = (idx: FakeIdx) =>
  idx.requests
    .filter((url) => !url.startsWith(ANNOUNCEMENTS))
    .map((url) => new URL(url).pathname)

// Two disclosures of 24 November 2026 as IDX listed them in each language,
// probed 2026-11-26, trimmed to two replies.
export const RECORDED: Record<DisclosureLanguage, ReadonlyArray<Reply>> = {
  id: recordedId.Replies,
  en: recordedEn.Replies,
}

// Lists the recorded disclosures, and serves each of their files.
export const publishRecorded = (idx: FakeIdx) => {
  for (const language of ["id", "en"] as const)
    for (const reply of RECORDED[language]) {
      idx.versions[language].push(reply)
      for (const { FullSavePath } of reply.attachments) {
        const path = new URL(String(FullSavePath)).pathname
        idx.files.set(path, { body: bodyOf(path) })
      }
    }
}
