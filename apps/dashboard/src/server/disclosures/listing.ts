// IDX's Keterbukaan Informasi list, read from `www.idx.id`'s GetAnnouncement,
// which serves it without the Cloudflare challenge `www.idx.co.id` answers a
// Worker with (as ../shareholding/listing.ts reads its own list). It answers
// `{ResultCount, Replies: [{pengumuman, attachments}]}`, newest first, for a
// span of days in one language. Spec apinrdw/kumora#715, "Source".
import { jsonBytes, NonRetryable } from "@workspace/server"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"

import { readCappedJson } from "../archive/capped-body.ts"
import {
  type DisclosureKey,
  type DisclosureLanguage,
  disclosureKeyOf,
} from "./key.ts"

const ANNOUNCEMENTS = "https://www.idx.id/primary/ListedCompany/GetAnnouncement"

// Replies a page asks for: IDX answers up to 500.
export const PAGE_SIZE = 500

// The most bytes one reply may take as JSON. A reply with six attachments
// took ~3.5 KB on 2026-11-26.
const MAX_REPLY_BYTES = 16 * 1024

// The most bytes a page's response may take; past it, the listing fails
// before decoding it.
const MAX_PAGE_BYTES = PAGE_SIZE * MAX_REPLY_BYTES

// The most pages one day's listing in one language reads: 5,000 disclosures,
// against ~200 on a usual day and 1,773 on 2024-04-30, an annual-report
// deadline. A step holds one page at a time.
export const MAX_DAY_PAGES = 10

// The longest attachment path kept: it is part of the attachment's key in
// the bucket and of each step result that names it.
export const MAX_PATH_LENGTH = 400

// The longest disclosure key kept, for the same reason. IDX's are ~40
// characters.
export const MAX_KEY_LENGTH = 200

const Page = Schema.Struct({
  ResultCount: Schema.Number,
  Replies: Schema.Array(
    Schema.Struct({
      pengumuman: Schema.Struct({ Id2: Schema.String }),
      attachments: Schema.Array(Schema.Struct({ FullSavePath: Schema.String })),
    })
  ),
})

// A version as a listing step stores it: its key, the reply exactly as IDX
// sent it, and its attachments' paths, each once.
export interface ListedVersion {
  readonly key: DisclosureKey
  readonly reply: string
  readonly paths: ReadonlyArray<string>
}

// The listing couldn't be read: the run fails with this message, which the
// admin page shows.
class ListingUnreadable extends Schema.TaggedError<ListingUnreadable>()(
  "ListingUnreadable",
  { message: Schema.String }
) {}

const listingUrl = Effect.fnUntraced(function* (
  day: string,
  language: DisclosureLanguage,
  indexFrom: number
) {
  const date = day.replaceAll("-", "")
  const url = new URL(ANNOUNCEMENTS)
  for (const [name, value] of [
    ["kodeEmiten", ""],
    ["emitenType", "*"],
    ["indexFrom", String(indexFrom)],
    ["pageSize", String(PAGE_SIZE)],
    ["dateFrom", date],
    ["dateTo", date],
    ["lang", language],
    ["keyword", ""],
  ])
    url.searchParams.set(name, value)
  return url.href
})

// The attachment's path on IDX's site, which www.idx.id serves as
// www.idx.co.id lists it.
const pathOf = Effect.fnUntraced(function* (fullSavePath: string) {
  const path = URL.canParse(fullSavePath)
    ? new URL(fullSavePath).pathname
    : undefined
  if (path === undefined || path.length > MAX_PATH_LENGTH)
    return yield* new NonRetryable({
      message: `IDX listed an attachment at ${fullSavePath.slice(0, 200)}, not a URL of at most ${MAX_PATH_LENGTH} characters`,
    })
  return path
})

const versionOf = Effect.fnUntraced(function* (
  language: DisclosureLanguage,
  raw: unknown,
  reply: (typeof Page.Type)["Replies"][number]
) {
  const key = yield* disclosureKeyOf(reply.pengumuman.Id2, language)
  if (key === undefined || key.length > MAX_KEY_LENGTH)
    return yield* new NonRetryable({
      message: `IDX listed a disclosure whose Id2 isn't a publish time and number in ${language}: ${reply.pengumuman.Id2.slice(0, 200)}`,
    })
  if ((yield* jsonBytes(raw)) > MAX_REPLY_BYTES)
    return yield* new NonRetryable({
      message: `IDX listed disclosure ${key} in over ${MAX_REPLY_BYTES} bytes`,
    })
  const paths = yield* Effect.forEach(reply.attachments, ({ FullSavePath }) =>
    pathOf(FullSavePath)
  )
  return {
    key,
    reply: JSON.stringify(raw),
    paths: [...new Set(paths)],
  } satisfies ListedVersion
})

// One page of `day`'s listing in `language`, from `indexFrom`, and how many
// the whole listing holds.
const readPage = Effect.fnUntraced(function* (
  day: string,
  language: DisclosureLanguage,
  indexFrom: number
) {
  const url = yield* listingUrl(day, language, indexFrom)
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const raw = yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      readCappedJson(response, MAX_PAGE_BYTES, `IDX's disclosures of ${day}`)
    ),
    Effect.catchTag("HttpClientError", ({ reason }) =>
      Effect.fail(
        new ListingUnreadable({
          message:
            reason._tag === "StatusCodeError"
              ? `IDX's disclosures of ${day} (${language}) answered ${reason.response.status} (${url})`
              : `IDX's disclosures of ${day} (${language}) couldn't be read: ${reason.message}`,
        })
      )
    )
  )
  const page = yield* Schema.decodeUnknownEffect(Page)(raw).pipe(
    // IDX changed the listing: retrying won't fix it.
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new NonRetryable({
          message: `IDX's disclosures no longer match their Schema: ${error.message}`,
        })
      )
    )
  )
  const rawReplies = (raw as { readonly Replies: ReadonlyArray<unknown> })
    .Replies
  return {
    total: page.ResultCount,
    versions: yield* Effect.forEach(page.Replies, (reply, index) =>
      versionOf(language, rawReplies[index], reply)
    ),
  }
})

// Every version IDX lists for `day` in `language`, a page at a time: `each`
// takes each page's versions before the next page is read, so a step holds
// one page at most.
export const forEachListedPage = Effect.fnUntraced(function* <E, R>(
  day: string,
  language: DisclosureLanguage,
  each: (versions: ReadonlyArray<ListedVersion>) => Effect.Effect<void, E, R>
) {
  let read = 0
  for (let page = 0; ; page++) {
    if (page === MAX_DAY_PAGES)
      return yield* new NonRetryable({
        message: `IDX lists more than ${MAX_DAY_PAGES * PAGE_SIZE} disclosures on ${day} (${language}), more than a disclosure run reads`,
      })
    const { total, versions } = yield* readPage(day, language, read)
    yield* each(versions)
    read += versions.length
    if (versions.length === 0 || read >= total) return read
  }
})
