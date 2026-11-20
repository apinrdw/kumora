// The recorded days bucket (spec apinrdw/kumora#556, "The layout"): the
// stage's R2 bucket (DAYS_BUCKET in alchemy.run.ts) that holds cold days.
// This module is the one home of its key layout, its writes, and the two
// answers a cold read sends: a stored answer, sealed, or Not recorded.
import {
  type RecordedResource,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Effect, Schema } from "effect"

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

// Decision: the answers' folder names their format's version, not the live
// socket's: protocol 8 changed only live book readings, so days moved under
// v7 stay readable and new days still go there. Bump it only with a stored
// answer's change, converting the days already moved. See apinrdw/kumora#606.
const ANSWERS_VERSION = 7

// Decision: a day's keys sit under `days/{date}/`. Its answers sit under
// their format's version (`ANSWERS_VERSION`), as each was built for a page;
// `status.json` (the broker codes protocol's) and `manifest.json` sit beside
// that folder. A later change to an answer's format converts on read or
// rewrites the day R2 to R2. See spec apinrdw/kumora#556, "The layout".
export const dayKeys = (date: WibDate) =>
  Effect.sync(() => {
    const day = `days/${date}`
    const answers = `${day}/v${ANSWERS_VERSION}`
    return {
      // The folder of the answers, by their format's version.
      answers,
      // The day's final broker codes status, as its status GET answered at
      // the move (`after` 0: every missing range).
      status: `${day}/status.json`,
      // Written last: its presence means the day moved whole.
      manifest: `${day}/manifest.json`,
      // The day's answer to the next trading day's ask for its values
      // (previous-values.ts), as its object answered it.
      dayValues: `${day}/day-values.json`,
      // Whether the day recorded book events: what a code without a stored
      // BookEvents answer answers.
      bookEvents: `${answers}/book-events.json`,
      // One code's order books: its chunks behind a minute index
      // (cold-books.ts).
      book: (code: StockCode) => `${answers}/book/${code}.bin`,
      // The tape's blocks behind its index (cold-tape.ts); a segment is
      // named by its first trade's number.
      tapeIndex: `${answers}/tape/index.json`,
      tapeSegment: (segment: string) => `${answers}/tape/${segment}.bin`,
    }
  })
export type DayKeys = Effect.Success<ReturnType<typeof dayKeys>>

// The key of a resource answered by one stored object; none for one read
// otherwise: Tape and BrokerCodes read tape blocks (cold-tape.ts), and Book
// reads ranges of its code's object. A code with no stored BookEvents answer
// answers none from the day's `bookEvents` (cold-days.ts).
export const answerKey = (date: WibDate, resource: RecordedResource) =>
  Effect.map(dayKeys(date), ({ answers: folder }) => {
    switch (resource._tag) {
      case "Codes":
        return `${folder}/codes.json.gz`
      case "Gaps":
        return `${folder}/gaps.json.gz`
      case "Candles":
        return `${folder}/candles/${resource.code}.json.gz`
      case "Sweeps":
        return `${folder}/sweeps/${resource.code}.json.gz`
      case "SweepBrokers":
        return `${folder}/sweep-brokers/${resource.code}.json.gz`
      case "Heatmap":
        return `${folder}/heatmap/${resource.code}.json.gz`
      case "BookEvents":
        return `${folder}/book-events/${resource.code}.json.gz`
      default:
        return undefined
    }
  })

// R2 refused a write; the move stops before the day is marked cold.
class ColdWriteFailed extends Schema.TaggedError<ColdWriteFailed>()(
  "ColdWriteFailed",
  { key: Schema.String, cause: Schema.Defect() }
) {}

export const putObject = (
  bucket: DayBucket,
  key: string,
  body: Uint8Array | string,
  contentType: string
) =>
  Effect.tryPromise({
    try: () => bucket.put(key, body, { httpMetadata: { contentType } }),
    catch: (cause) => new ColdWriteFailed({ key, cause }),
  })

// A cold day's JSON answer, cached for good. A stored gzip is sent as it is:
// the browser decodes it.
// Decision: `encodeBody: "manual"` keeps workerd from gzipping the stored gzip
// again. Set through a variable, as the tests' typecheck has no Workers
// types, whose ResponseInit names it.
export const sealedAnswer = (
  body: ReadableStream | string,
  encoding: "gzip" | "plain"
) =>
  Effect.sync(() => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": SEALED_CACHE,
    }
    if (encoding === "plain") return new Response(body, { headers })
    const init = {
      headers: { ...headers, "Content-Encoding": "gzip" },
      encodeBody: "manual" as const,
    }
    return new Response(body, init)
  })

// What a cold day answers for what it doesn't hold, never cached.
export const notStored = Effect.sync(() =>
  Response.json(
    { error: "NotFound", message: "Not recorded" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  )
)
