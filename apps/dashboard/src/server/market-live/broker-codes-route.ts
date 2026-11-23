// The broker codes route in the Worker entry (spec apinrdw/kumora#244,
// "Dashboard: the route"): `/api/broker-codes/<date>`, ahead of TanStack
// Start. The extension posts a day's batches and asks its status with the
// ingest token as its bearer; there is no viewer session and no sign-in
// gate. Each reaches the named day's trading-day Durable Object.
import {
  BROKER_CODES_AUTH_SCHEME,
  BROKER_CODES_BATCH_LIMIT,
  type WibDate,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Option, Schema } from "effect"

import { checkedBatch, noStoreAnswer } from "./broker-codes.ts"
import { ingestTokenMatches } from "./ingest-token.ts"
import { ObjectPath } from "./routes.ts"

// Decision: every broker codes answer allows any origin; preflight before token
// (apps/dashboard/docs/adr/0054-broker-codes-answers-allow-any-origin.md)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

const withCors = (response: Response) =>
  Effect.sync(() => {
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(CORS)) headers.set(name, value)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })

const authorized = Effect.fnUntraced(function* (request: Request) {
  const header = request.headers.get("authorization")
  if (header === null || !header.startsWith(BROKER_CODES_AUTH_SCHEME))
    return false
  return yield* ingestTokenMatches(
    header.slice(BROKER_CODES_AUTH_SCHEME.length)
  )
})

class BodyTooLong extends Schema.TaggedError<BodyTooLong>()(
  "BodyTooLong",
  {}
) {}

// Decision: a batch holds at most 5,000 rows, read up to BROKER_CODES_BATCH_LIMIT
// (packages/relay/docs/adr/0012-a-broker-codes-batch-fits-one-byte-limit-on-both-sides.md)
const boundedText = Effect.fnUntraced(function* (request: Request) {
  const reader = request.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Array<Uint8Array> = []
  let length = 0
  for (;;) {
    const { done, value } = yield* Effect.promise(() => reader.read())
    if (done) break
    length += value.byteLength
    if (length > BROKER_CODES_BATCH_LIMIT) {
      yield* Effect.promise(() => reader.cancel())
      return yield* new BodyTooLong()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(body)
})

const toTradingDay = Effect.fnUntraced(function* (
  day: WibDate,
  init: RequestInit,
  search = ""
) {
  const env = yield* WorkerEnv
  const object = env.TRADING_DAY.getByName(day)
  // A new request, so no header the client sent reaches the object. A
  // GET's query goes on, which the object checks.
  const request = new Request(
    new URL(
      `${ObjectPath.brokerCodes}${search}`,
      "https://trading-day.invalid"
    ),
    init
  )
  return yield* Effect.promise((): Promise<Response> => object.fetch(request))
})

// Checked here before the object is reached: the token (401), the date
// (400), the method (405), and a POST's batch: its length (413), its version
// (426), its shape and its day (400). The object answers 200 once the batch
// is written, and the status with `no-store`.
const post = Effect.fnUntraced(
  function* (request: Request, day: WibDate) {
    const text = yield* boundedText(request)
    const batch = yield* checkedBatch(text, day)
    if (batch instanceof Response) return batch
    return yield* toTradingDay(day, { method: "POST", body: text })
  },
  Effect.catchTag("BodyTooLong", () => noStoreAnswer(413, "Batch too long"))
)

const answer = Effect.fnUntraced(function* (
  request: Request,
  day: Option.Option<WibDate>
) {
  if (request.method === "OPTIONS") return yield* noStoreAnswer(204)
  if (!(yield* authorized(request)))
    return yield* noStoreAnswer(401, "Bad token")
  if (Option.isNone(day)) return yield* noStoreAnswer(400, "No such day")
  if (request.method === "POST") return yield* post(request, day.value)
  if (request.method === "GET")
    return yield* toTradingDay(
      day.value,
      { method: "GET" },
      new URL(request.url).search
    )
  return yield* noStoreAnswer(405, "GET or POST", {
    Allow: "GET, POST, OPTIONS",
  })
})

export const brokerCodesRoute = (
  request: Request,
  day: Option.Option<WibDate>
) => Effect.flatMap(answer(request, day), withCors)
