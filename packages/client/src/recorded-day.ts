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
  decodeRecordedBrokerCodes,
  decodeRecordedCandles,
  decodeRecordedGaps,
  decodeRecordedTape,
  recordedDayPath,
  type RecordedBrokerCodes,
  type RecordedResource,
  type StockCode,
  type TradeCodes,
  type TradeNumber,
  type WibDate,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Duration, Effect, Option, Predicate } from "effect"
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

// The broker codes of the trades the tape at `at` holds, and whether the
// day's codes are complete; a 404, a date that isn't a recorded day, reads as
// none. `fresh` asks the Worker past the browser's copy, for the recheck
// while incomplete.
export const fetchRecordedBrokerCodes = Effect.fnUntraced(function* (
  date: WibDate,
  at: DateTime.Utc,
  fresh = false
) {
  const body = yield* getResource(date, { _tag: "BrokerCodes", at }).pipe(
    fresh
      ? Effect.provideService(FetchHttpClient.RequestInit, { cache: "reload" })
      : (effect) => effect
  )
  if (Option.isNone(body))
    return { codes: [], complete: false } satisfies RecordedBrokerCodes
  return yield* decodeRecordedBrokerCodes(body.value)
})

// The broker codes the tape's rows show, by Trade number.
export type RecordedTradeCodes = ReadonlyMap<TradeNumber, TradeCodes>

/**
 * Shows the newest answer: the function this makes runs `answer` and hands
 * what it returns to `show`, unless the answer to a later run is already
 * shown.
 */
export const makeNewestWins = Effect.sync(() => {
  let asked = 0
  let shown = 0
  return <A, E, R>(answer: Effect.Effect<A, E, R>, show: (value: A) => void) =>
    Effect.suspend(() => {
      asked += 1
      const id = asked
      return Effect.map(answer, (value) => {
        if (id < shown) return
        shown = id
        show(value)
      })
    })
})

// Decision: while the day's codes are incomplete, the page asks again every
// 30 s (spec apinrdw/kumora#280, "Recheck"); the walks store codes for over
// an hour after the seal.
const RECHECK = Duration.seconds(30)

/**
 * Follows a recorded day's broker codes beside its tape. `ask` fetches the
 * codes for a cursor the tape was just asked for, and shows them unless a
 * later ask's answer is already shown. `recheck` asks again for the latest
 * cursor every 30 s, past the browser's copy, until an answer shown says the
 * day is complete; a failed recheck other than a 401 is logged and the next
 * one goes ahead.
 */
export const makeBrokerCodesFollower = (
  date: WibDate,
  show: (codes: RecordedTradeCodes) => void
) =>
  Effect.gen(function* () {
    const newest = yield* makeNewestWins
    let complete = false
    let latest: DateTime.Utc | undefined
    const ask = (at: DateTime.Utc, fresh = false) =>
      Effect.suspend(() => {
        latest = at
        return newest(fetchRecordedBrokerCodes(date, at, fresh), (answer) => {
          complete = answer.complete
          show(new Map(answer.codes))
        })
      })
    const recheck = Effect.gen(function* () {
      while (!complete) {
        yield* Effect.sleep(RECHECK)
        if (complete || latest === undefined) continue
        yield* ask(latest, true).pipe(
          Effect.catchIf(
            (error) => !Predicate.isTagged(error, "SignInRequired"),
            (error) => Effect.logWarning("Broker codes not rechecked", error)
          )
        )
      }
    })
    return { ask: (at: DateTime.Utc) => ask(at), recheck }
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

// The day's relay gaps.
export const fetchRecordedGaps = Effect.fnUntraced(function* (date: WibDate) {
  const body = yield* getResource(date, { _tag: "Gaps" })
  if (Option.isNone(body)) return []
  return (yield* decodeRecordedGaps(body.value)).gaps
})
