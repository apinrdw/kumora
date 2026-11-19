// Cold days in R2 (spec apinrdw/kumora#556, "The layout" and "The move"): a
// sealed day's finished answers, gzipped, in the stage's recorded days bucket
// (DAYS_BUCKET in alchemy.run.ts). This module holds the key layout, the move
// that writes a day's answers and marks it cold, and the read the Worker
// answers a cold day's GET with (days.ts).
import { gzipSync } from "node:zlib"

import {
  MINUTE_MS,
  ViewerProtocolVersion,
  type RecordedResource,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import type { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Schema } from "effect"

import {
  BOOK_INDEX_BYTES,
  chunkRange,
  packBook,
  type StoredBookChunk,
} from "./cold-books.ts"
import { coldTapeAnswer, writeTape, type TapeSource } from "./cold-tape.ts"
import { SEALED_CACHE } from "./routes.ts"

// The binding's members the move and the read use; R2Bucket meets this shape
// under Workers types, as bucket-r2.ts explains. A `range` reads `length`
// bytes from `offset`.
export interface DayBucket {
  readonly put: (
    key: string,
    body: Uint8Array | string,
    options: { readonly httpMetadata: { readonly contentType: string } }
  ) => Promise<unknown>
  readonly get: (
    key: string,
    options?: {
      readonly range?: { readonly offset: number; readonly length: number }
    }
  ) => Promise<{ readonly body: ReadableStream } | null>
}

// Decision: a day's keys sit under `days/{date}/`. Its answers sit under
// the viewer protocol's version, as each was built for that version's page;
// `status.json` (the broker codes protocol's) and `manifest.json` sit beside
// that folder. A later change to an answer's format converts on read or
// rewrites the day R2 to R2. See spec apinrdw/kumora#556, "The layout".
const dayFolder = (date: WibDate) => `days/${date}`
const answerFolder = (date: WibDate) =>
  `${dayFolder(date)}/v${ViewerProtocolVersion}`

// The day's final broker codes status, as its status GET answered at the
// move (`after` 0: every missing range).
const statusKey = (date: WibDate) => `${dayFolder(date)}/status.json`

// Written last: its presence means the day moved whole.
const manifestKey = (date: WibDate) => `${dayFolder(date)}/manifest.json`

const Manifest = Schema.Struct({ viewerProtocol: Schema.Int })
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest))

// The key of a resource answered by one stored object; none for a resource
// still answered by the day's object. Tape and BrokerCodes read tape blocks
// (cold-tape.ts), and Book (`coldBook`) reads ranges of its code's object.
const answerKey = (date: WibDate, resource: RecordedResource) => {
  switch (resource._tag) {
    case "Codes":
      return `${answerFolder(date)}/codes.json.gz`
    case "Gaps":
      return `${answerFolder(date)}/gaps.json.gz`
    case "Candles":
      return `${answerFolder(date)}/candles/${resource.code}.json.gz`
    case "Sweeps":
      return `${answerFolder(date)}/sweeps/${resource.code}.json.gz`
    case "SweepBrokers":
      return `${answerFolder(date)}/sweep-brokers/${resource.code}.json.gz`
    case "Heatmap":
      return `${answerFolder(date)}/heatmap/${resource.code}.json.gz`
    default:
      return undefined
  }
}

// One code's order books: its chunks behind a minute index (cold-books.ts).
const bookKey = (date: WibDate, code: StockCode) =>
  `${answerFolder(date)}/book/${code}.bin`

// The resources the move writes, each once for the day.
const DAY_RESOURCES: ReadonlyArray<RecordedResource> = [
  { _tag: "Codes" },
  { _tag: "Gaps" },
]

// Each code's resources the move writes, one object per view and code.
const codeResources = (code: StockCode): ReadonlyArray<RecordedResource> => [
  { _tag: "Candles", code },
  { _tag: "Sweeps", code },
  { _tag: "SweepBrokers", code },
  { _tag: "Heatmap", code },
]

// R2 refused a write; the move stops before the day is marked cold.
class ColdWriteFailed extends Schema.TaggedError<ColdWriteFailed>()(
  "ColdWriteFailed",
  { key: Schema.String, cause: Schema.Defect() }
) {}

const put = (
  bucket: DayBucket,
  key: string,
  body: Uint8Array | string,
  contentType: string
) =>
  Effect.tryPromise({
    try: () => bucket.put(key, body, { httpMetadata: { contentType } }),
    catch: (cause) => new ColdWriteFailed({ key, cause }),
  })

// What a move writes to and tells.
export interface ColdTarget {
  readonly bucket: DayBucket
  // Marks the day cold in the day index; run once the manifest is written.
  readonly markCold: Effect.Effect<void, unknown, WorkerEnv>
}

// Moves a sealed day's answers to R2: each answer, the tape's blocks and
// index (cold-tape.ts), each code's book (cold-books.ts), then `status.json`,
// then `manifest.json`, then the index marks the day cold. Each step rewrites the
// same key, so a move that fails partway leaves the day hot, and a retry is
// safe. An answer that isn't a 200 (a day with no code list) is not written,
// so the cold read answers it 404.
// Decision: per-code views are written for each code the day's list names,
// the only ones the page asks for; another code answers 404 once cold.
// SweepBrokers is stored as found, its `complete` included, and cached for
// good like every cold answer: a cold day takes no more broker codes. See
// spec apinrdw/kumora#556, "Routing and caching".
export const moveDay = Effect.fnUntraced(function* (options: {
  readonly date: WibDate
  readonly target: ColdTarget
  // The day's own answer to a recorded day GET (recorded-answers.ts).
  readonly answer: (
    resource: RecordedResource
  ) => Effect.Effect<Response, unknown, WorkerEnv>
  // The day's broker codes status answer.
  readonly status: Effect.Effect<Response, unknown>
  // The codes the day's code list names; their views are stored per code.
  readonly codes: ReadonlyArray<StockCode>
  readonly tape: TapeSource
  // The day's stored book chunks, by code (day-store.ts).
  readonly books: {
    readonly codes: Effect.Effect<ReadonlyArray<StockCode>>
    readonly chunksOf: (
      code: StockCode
    ) => Effect.Effect<ReadonlyArray<StoredBookChunk>>
  }
}) {
  const { date, target } = options
  for (const resource of [
    ...DAY_RESOURCES,
    ...options.codes.flatMap(codeResources),
  ]) {
    const key = answerKey(date, resource)
    if (key === undefined) continue
    const response = yield* options.answer(resource)
    const text = yield* Effect.promise(() => response.text())
    if (response.status !== 200) continue
    yield* put(target.bucket, key, gzipSync(text), "application/json")
  }
  yield* writeTape(answerFolder(date), options.tape, (key, body) =>
    put(target.bucket, key, body, "application/octet-stream")
  )
  for (const code of yield* options.books.codes)
    yield* put(
      target.bucket,
      bookKey(date, code),
      packBook(yield* options.books.chunksOf(code)),
      "application/octet-stream"
    )
  const status = yield* options.status
  yield* put(
    target.bucket,
    statusKey(date),
    yield* Effect.promise(() => status.text()),
    "application/json"
  )
  yield* put(
    target.bucket,
    manifestKey(date),
    yield* encodeManifest({ viewerProtocol: ViewerProtocolVersion }),
    "application/json"
  )
  yield* target.markCold
})

// The stored bytes, sent as they are: the browser decodes the gzip.
// Decision: `encodeBody: "manual"` keeps workerd from gzipping the stored gzip
// again. Set through a variable, as the tests' typecheck has no Workers
// types, whose ResponseInit names it.
const storedGzip = (body: ReadableStream) =>
  Effect.sync(() => {
    const init = {
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Cache-Control": SEALED_CACHE,
      },
      encodeBody: "manual" as const,
    }
    return new Response(body, init)
  })

const notStored = Effect.sync(() =>
  Response.json(
    { error: "NotFound", message: "Not recorded" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  )
)

const bytesOf = (body: ReadableStream) =>
  Effect.promise(() =>
    new Response(body).arrayBuffer().then((bytes) => new Uint8Array(bytes))
  )

// A code's stored chunk for the minute holding `minute`, or the latest
// before it: the object's index, then that chunk's range. Not recorded when
// the code has no book, or none yet at that minute.
const coldBook = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate,
  code: StockCode,
  minute: number
) {
  const key = bookKey(date, code)
  const head = yield* Effect.promise(() =>
    bucket.get(key, { range: { offset: 0, length: BOOK_INDEX_BYTES } })
  )
  if (head === null) return yield* notStored
  const range = chunkRange(
    yield* bytesOf(head.body),
    Math.floor(minute / MINUTE_MS) * MINUTE_MS
  )
  if (range === undefined) return yield* notStored
  const chunk = yield* Effect.promise(() => bucket.get(key, { range }))
  return chunk === null ? yield* notStored : yield* storedGzip(chunk.body)
})

// A cold day's answer to `resource` from R2; none for a resource still
// answered by the day's object.
export const coldAnswer = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate,
  resource: RecordedResource
) {
  if (resource._tag === "Book")
    return yield* coldBook(
      bucket,
      date,
      resource.code,
      DateTime.toEpochMillis(resource.minute)
    )
  if (resource._tag === "Tape" || resource._tag === "BrokerCodes")
    return (
      (yield* coldTapeAnswer(bucket, answerFolder(date), resource)) ??
      (yield* notStored)
    )
  const key = answerKey(date, resource)
  if (key === undefined) return undefined
  const stored = yield* Effect.promise(() => bucket.get(key))
  return stored === null ? yield* notStored : yield* storedGzip(stored.body)
})
