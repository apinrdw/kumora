// Recorded day loads from the dashboard Worker (spec apinrdw/kumora#138,
// "Recorded day loads"). Each GET answers none when nothing was recorded
// (404); a 401 fails SignInRequired, so the page sends the visitor to sign
// in.
// Decision: any other status fails, a 5xx included. The page keeps None as a
// minute's missing book chunk and never asks again, so a Worker that can't
// answer must not look like one that recorded nothing. See apinrdw/kumora#157.
import {
  DayStripPath,
  decodeBookChunk,
  decodeDayStrip,
  decodeRecordedCandles,
  decodeRecordedGaps,
  decodeRecordedHeatmap,
  decodeRecordedTape,
  recordedDayPath,
  type RecordedResource,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect, Option } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

import { SignInRequired } from "./market-live-socket.ts"

// The body of a 200 answer to `path`.
export const getRecorded = Effect.fnUntraced(function* (path: string) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(path)
  if (response.status === 401) return yield* new SignInRequired()
  if (response.status === 404) return Option.none<string>()
  const ok = yield* HttpClientResponse.filterStatusOk(response)
  return Option.some(yield* ok.text)
})

const getResource = (date: WibDate, resource: RecordedResource) =>
  Effect.flatMap(recordedDayPath(date, resource), getRecorded)

// Every sealed day, newest first; none before the first day is sealed. The
// browser keeps the answer until a minute past the next 17:00 WIB seal, as
// the Worker's Cache-Control says (apps/dashboard day-index.ts); `fresh`
// asks the Worker past that copy, for the row the seal just wrote.
export const fetchDayStrip = (fresh = false) =>
  Effect.gen(function* () {
    const body = yield* getRecorded(DayStripPath)
    if (Option.isNone(body)) return []
    return (yield* decodeDayStrip(body.value)).days
  }).pipe(
    fresh
      ? Effect.provideService(FetchHttpClient.RequestInit, { cache: "reload" })
      : (effect) => effect
  )

// One code's whole-day candles and its previous close.
export const fetchRecordedCandles = Effect.fnUntraced(function* (
  date: WibDate,
  code: StockCode
) {
  const body = yield* getResource(date, { _tag: "Candles", code })
  if (Option.isNone(body)) return Option.none()
  return Option.some(yield* decodeRecordedCandles(body.value))
})

// The 200 newest running trades at or before `at`, ascending.
export const fetchRecordedTape = Effect.fnUntraced(function* (
  date: WibDate,
  at: DateTime.Utc
) {
  const body = yield* getResource(date, { _tag: "Tape", at })
  if (Option.isNone(body)) return []
  return (yield* decodeRecordedTape(body.value)).trades
})

// The selected code's stored book chunk for `minute`'s minute (or the latest
// before it); the page replays it to the cursor with `bookAt`. None when the
// code had no book by then.
export const fetchRecordedBookChunk = Effect.fnUntraced(function* (
  date: WibDate,
  code: StockCode,
  minute: DateTime.Utc
) {
  const body = yield* getResource(date, { _tag: "Book", code, minute })
  if (Option.isNone(body)) return Option.none()
  return Option.some(yield* decodeBookChunk(body.value))
})

// One code's book heatmap slices: a sealed day's whole, a live day's up to
// the slice time the answer names. None when the Worker has none.
export const fetchRecordedHeatmap = Effect.fnUntraced(function* (
  date: WibDate,
  code: StockCode
) {
  const body = yield* getResource(date, { _tag: "Heatmap", code })
  if (Option.isNone(body)) return Option.none()
  return Option.some(yield* decodeRecordedHeatmap(body.value))
})

// The day's relay gaps.
export const fetchRecordedGaps = Effect.fnUntraced(function* (date: WibDate) {
  const body = yield* getResource(date, { _tag: "Gaps" })
  if (Option.isNone(body)) return []
  return (yield* decodeRecordedGaps(body.value)).gaps
})
