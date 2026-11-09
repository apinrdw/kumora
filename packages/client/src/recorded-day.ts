// Recorded day loads from the dashboard Worker (spec apinrdw/kumora#138,
// "Recorded day loads"). Each GET answers none when nothing was recorded
// (404) or the Worker can't answer; a 401 fails SignInRequired, so the page
// sends the visitor to sign in.
import {
  DayStripPath,
  bookAt,
  decodeBookChunk,
  decodeDayStrip,
  decodeRecordedCandles,
  decodeRecordedGaps,
  decodeRecordedTape,
  recordedDayPath,
  type RecordedResource,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect, Option } from "effect"
import * as HttpClient from "effect/http/HttpClient"

import { SignInRequired } from "./market-live-socket.ts"

// The body of a 200 answer to `path`.
export const getRecorded = Effect.fnUntraced(function* (path: string) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(path)
  if (response.status === 401) return yield* new SignInRequired()
  if (response.status !== 200) return Option.none<string>()
  return Option.some(yield* response.text)
})

const getResource = (date: WibDate, resource: RecordedResource) =>
  Effect.flatMap(recordedDayPath(date, resource), getRecorded)

// Every sealed day, newest first; none when the index can't answer.
export const fetchDayStrip = Effect.gen(function* () {
  const body = yield* getRecorded(DayStripPath)
  if (Option.isNone(body)) return []
  return (yield* decodeDayStrip(body.value)).days
})

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

// The stored order book frame in force at `cursor`: the chunk of the
// cursor's minute, replayed to it. Undefined when none was recorded.
export const fetchRecordedBook = Effect.fnUntraced(function* (
  date: WibDate,
  code: StockCode,
  cursor: DateTime.Utc
) {
  const body = yield* getResource(date, {
    _tag: "Book",
    code,
    minute: cursor,
  })
  if (Option.isNone(body)) return undefined
  return yield* bookAt(yield* decodeBookChunk(body.value), cursor)
})

// The day's relay gaps.
export const fetchRecordedGaps = Effect.fnUntraced(function* (date: WibDate) {
  const body = yield* getResource(date, { _tag: "Gaps" })
  if (Option.isNone(body)) return []
  return (yield* decodeRecordedGaps(body.value)).gaps
})
