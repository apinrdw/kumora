// Cold days in R2 (spec apinrdw/kumora#556, "The move"): a sealed day's
// finished answers, gzipped, in the recorded days bucket (cold-bucket.ts).
// This module holds the move's steps that write a day's answers and mark it
// cold, the read the Worker answers a cold day's GET with (days.ts), and the
// emptied object's answers (`coldDay`).
import { gzipSync } from "node:zlib"

import {
  BrokerCodesProtocolVersion,
  MINUTE_MS,
  NO_ORDER_NUMBERS,
  StockCode,
  TradeNumber,
  brokerCodesAfter,
  decodeBrokerCodesStatus,
  encodeBrokerCodesStatus,
  encodeRecordedBookEvents,
  ViewerProtocolVersion,
  type RecordedResource,
  type WibDate,
} from "@workspace/relay"
import type { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Option, Schema } from "effect"

import {
  answerKey,
  dayKeys,
  notStored,
  putObject,
  sealedAnswer,
  type DayBucket,
} from "./cold-bucket.ts"
import {
  BOOK_INDEX_BYTES,
  chunkRange,
  packBook,
  type StoredBookChunk,
} from "./cold-books.ts"
import {
  TapeProgress,
  coldTapeAnswer,
  writeTapeRun,
  type TapeSource,
} from "./cold-tape.ts"
import { checkedBatch, noStoreAnswer } from "./broker-codes.ts"
import { dayValuesResponse, noDayValues } from "./previous-values.ts"

const Manifest = Schema.Struct({ viewerProtocol: Schema.Int })
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest))

// Whether the day recorded book events (`bookEvents` in cold-bucket.ts).
const BookEventsRecorded = Schema.fromJsonString(
  Schema.Struct({ recorded: Schema.Boolean })
)
const encodeBookEventsRecorded = Schema.encodeEffect(BookEventsRecorded)
const decodeBookEventsRecorded = Schema.decodeUnknownEffect(BookEventsRecorded)

// The resources the move writes, each once for the day.
const DAY_RESOURCES: ReadonlyArray<RecordedResource> = [
  { _tag: "Codes" },
  { _tag: "Gaps" },
]

// Each code's views the move writes, one object per view and code; and
// BookEvents for each code with an event.
const CODE_VIEWS = ["Candles", "Sweeps", "SweepBrokers", "Heatmap"] as const

// What a move writes to and tells.
export interface ColdTarget {
  readonly bucket: DayBucket
  // Marks the day cold in the day index; run once the manifest is written.
  readonly markCold: Effect.Effect<void, unknown, WorkerEnv>
}

// What a move reads its day through: the day's own answers
// (recorded-answers.ts), its broker codes status, its values, its book
// events, its tape and its books.
export interface DayToMove {
  readonly answer: (
    resource: RecordedResource
  ) => Effect.Effect<Response, unknown, WorkerEnv>
  readonly status: Effect.Effect<Response, unknown>
  // Its answer to the next trading day's ask for its values
  // (previous-values.ts).
  readonly dayValues: Effect.Effect<Response, unknown>
  // Whether the day recorded book events, and the codes with one stored.
  readonly bookEvents: {
    readonly recorded: Effect.Effect<boolean>
    readonly codes: Effect.Effect<ReadonlyArray<StockCode>>
  }
  // Every code with a view to store, ascending.
  readonly codes: Effect.Effect<ReadonlyArray<StockCode>, unknown>
  readonly tape: TapeSource
  // The day's stored book chunks, by code (day-store.ts).
  readonly books: {
    readonly codes: Effect.Effect<ReadonlyArray<StockCode>>
    readonly chunksOf: (
      code: StockCode
    ) => Effect.Effect<ReadonlyArray<StoredBookChunk>>
  }
}

// Where a move stopped: the step it runs next and, in a step that walks
// codes, the last code it wrote. Kept as a fact of the day (trading-day.ts).
export const MoveProgress = Schema.Union([
  Schema.TaggedStruct("Answers", { after: Schema.optionalKey(StockCode) }),
  Schema.TaggedStruct("Tape", { tape: TapeProgress }),
  Schema.TaggedStruct("Books", { after: Schema.optionalKey(StockCode) }),
  Schema.TaggedStruct("Finish", {}),
])
export type MoveProgress = typeof MoveProgress.Type

// Decision: a step per alarm, well under its 30 s of CPU: 250 codes' views
// (1,000 answers), 50 tape segments (500,000 trades) or 20 codes' books. The
// busy day moves in 9 runs, about 1.5 s each, 385 K rows read and 19 written
// (row-budgets.workerd.test.ts). See spec apinrdw/kumora#556, "The move".
const CODES_PER_RUN = 250
const SEGMENTS_PER_RUN = 50
const BOOKS_PER_RUN = 20

// The codes after `after`, at most `limit`, and whether any is left past
// them.
const slice = (
  codes: ReadonlyArray<StockCode>,
  after: StockCode | undefined,
  limit: number
) =>
  Effect.sync(() => {
    const from =
      after === undefined ? codes : codes.filter((code) => code > after)
    return { run: from.slice(0, limit), more: from.length > limit }
  })

// One step of a sealed day's move to R2 from `progress`, answering where
// the next starts; "Cold" once the index marked it. The steps: the day's
// answers and each code's views, the tape's blocks and index (cold-tape.ts),
// each code's book (cold-books.ts), then `status.json` and
// `day-values.json`, then `manifest.json`, then the index marks the day
// cold. Each step rewrites
// the same keys, so a move that fails partway leaves the day hot, and a
// retry is safe. An answer that isn't a 200 (a day with no code list) is
// not written, so the cold read answers it 404.
// Decision: views are written for each code listed, traded or booked: a
// walk day has no list, and every day replays with every view; another code
// answers 404 once cold. SweepBrokers is stored as found, cached for good:
// a cold day takes no more broker codes. See spec apinrdw/kumora#556,
// "Routing and caching".
export const moveStep = (
  date: WibDate,
  target: ColdTarget,
  day: DayToMove,
  progress: MoveProgress
) => {
  const step = { date, bucket: target.bucket, day }
  switch (progress._tag) {
    case "Answers":
      return writeAnswers(step, progress.after)
    case "Tape":
      return writeTape(step, progress.tape)
    case "Books":
      return writeBooks(step, progress.after)
    case "Finish":
      return finish(step, target.markCold)
  }
}

// What each step of a move writes from and to.
interface MoveStep {
  readonly date: WibDate
  readonly bucket: DayBucket
  readonly day: DayToMove
}

// The day's answers on its first run, and the views of the codes after
// `after`.
const writeAnswers = Effect.fnUntraced(function* (
  { date, bucket, day }: MoveStep,
  after: StockCode | undefined
) {
  const writeAnswer = Effect.fnUntraced(function* (resource: RecordedResource) {
    const key = yield* answerKey(date, resource)
    if (key === undefined) return
    const response = yield* day.answer(resource)
    const text = yield* Effect.promise(() => response.text())
    if (response.status !== 200) return
    yield* putObject(bucket, key, gzipSync(text), "application/json")
  })
  if (after === undefined) {
    for (const resource of DAY_RESOURCES) yield* writeAnswer(resource)
    yield* putObject(
      bucket,
      (yield* dayKeys(date)).bookEvents,
      yield* encodeBookEventsRecorded({
        recorded: yield* day.bookEvents.recorded,
      }),
      "application/json"
    )
  }
  const { run, more } = yield* slice(yield* day.codes, after, CODES_PER_RUN)
  // Decision: BookEvents is stored only for a code with an event; every
  // other code's answer is built from whether the day recorded them, stored
  // once (`noBookEvents`): book events are found only for codes a viewer
  // watched. A day moved before then answers BookEvents 404.
  const withEvents = new Set(yield* day.bookEvents.codes)
  for (const code of run) {
    for (const _tag of CODE_VIEWS) yield* writeAnswer({ _tag, code })
    if (withEvents.has(code)) yield* writeAnswer({ _tag: "BookEvents", code })
  }
  const next: MoveProgress = more
    ? { _tag: "Answers", after: run.at(-1)! }
    : { _tag: "Tape", tape: { segments: [] } }
  return next
})

const writeTape = Effect.fnUntraced(function* (
  { date, bucket, day }: MoveStep,
  progress: TapeProgress
) {
  const tape = yield* writeTapeRun(
    { date, bucket, tape: day.tape, segments: SEGMENTS_PER_RUN },
    progress
  )
  const next: MoveProgress =
    tape === undefined ? { _tag: "Books" } : { _tag: "Tape", tape }
  return next
})

// The books of the codes after `after`.
const writeBooks = Effect.fnUntraced(function* (
  { date, bucket, day }: MoveStep,
  after: StockCode | undefined
) {
  const { run, more } = yield* slice(
    yield* day.books.codes,
    after,
    BOOKS_PER_RUN
  )
  for (const code of run)
    yield* putObject(
      bucket,
      (yield* dayKeys(date)).book(code),
      yield* packBook(yield* day.books.chunksOf(code)),
      "application/octet-stream"
    )
  const next: MoveProgress = more
    ? { _tag: "Books", after: run.at(-1)! }
    : { _tag: "Finish" }
  return next
})

// `status.json` and `day-values.json`, then `manifest.json`, then the
// index's mark.
// Decision: the day's values are stored once at the move, as the next
// trading day's object asks for them only the morning after, by when the day
// is usually cold. Built as the hot answer is, from one pass over the
// day's candles (`storedBubbles`): about 400 K rows on a full day, once, on
// top of the busy day's 385 K. See spec apinrdw/kumora#517, "Data".
const finish = Effect.fnUntraced(function* (
  { date, bucket, day }: MoveStep,
  markCold: ColdTarget["markCold"]
) {
  const keys = yield* dayKeys(date)
  const status = yield* day.status
  yield* putObject(
    bucket,
    keys.status,
    yield* Effect.promise(() => status.text()),
    "application/json"
  )
  const values = yield* day.dayValues
  const valuesText = yield* Effect.promise(() => values.text())
  if (values.status === 200)
    yield* putObject(bucket, keys.dayValues, valuesText, "application/json")
  yield* putObject(
    bucket,
    keys.manifest,
    yield* encodeManifest({ viewerProtocol: ViewerProtocolVersion }),
    "application/json"
  )
  yield* markCold
  return "Cold" as const
})

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
  const key = (yield* dayKeys(date)).book(code)
  const head = yield* Effect.promise(() =>
    bucket.get(key, { range: { offset: 0, length: BOOK_INDEX_BYTES } })
  )
  if (head === null) return yield* notStored
  const range = yield* chunkRange(
    yield* bytesOf(head.body),
    Math.floor(minute / MINUTE_MS) * MINUTE_MS
  )
  if (range === undefined) return yield* notStored
  const chunk = yield* Effect.promise(() => bucket.get(key, { range }))
  return chunk === null
    ? yield* notStored
    : yield* sealedAnswer(chunk.body, "gzip")
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
    return (yield* coldTapeAnswer(bucket, date, resource)) ?? (yield* notStored)
  const key = yield* answerKey(date, resource)
  if (key === undefined) return undefined
  const stored = yield* Effect.promise(() => bucket.get(key))
  if (stored !== null) return yield* sealedAnswer(stored.body, "gzip")
  return resource._tag === "BookEvents"
    ? yield* noBookEvents(bucket, date, resource.code)
    : yield* notStored
})

// A code's BookEvents answer when it stored none: no events, recorded as
// the day stored; not recorded when the day stored neither.
const noBookEvents = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate,
  code: StockCode
) {
  const { bookEvents: key } = yield* dayKeys(date)
  const stored = yield* Effect.promise(() => bucket.get(key))
  if (stored === null) return yield* notStored
  const { recorded } = yield* decodeBookEventsRecorded(
    yield* Effect.promise(() => new Response(stored.body).text())
  )
  return yield* sealedAnswer(
    yield* encodeRecordedBookEvents({ code, recorded, events: [] }),
    "plain"
  )
}, Effect.orDie)

// A cold day's answer to the next trading day's ask for its values, as its
// object answered it before the move; 404 for a day moved before its values
// were stored, as a day the relay didn't seal.
export const coldDayValues = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate
) {
  const { dayValues: key } = yield* dayKeys(date)
  const stored = yield* Effect.promise(() => bucket.get(key))
  return stored === null ? noDayValues() : dayValuesResponse(stored.body)
})

// A stored final status's text as this protocol's status reads it.
// Decision: a day moved before protocol 5 stored its status at protocol 4,
// without order numbers; it holds none, so it answers this version with
// zero counts rather than failing the GET. See spec apinrdw/kumora#627,
// "Slice 1".
const decodeStoredStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)
const currentStatusText = (text: string) =>
  Effect.map(decodeStoredStatus(text), (stored) =>
    JSON.stringify({
      orderNumbers: NO_ORDER_NUMBERS,
      ...stored,
      version: BrokerCodesProtocolVersion,
    })
  )

// The broker codes status a cold day's status GET answers: the stored final
// status, its missing ranges listed past `after` as the hot status lists
// them. None when the move stored none.
// Decision: the stored status lists the day's first MISSING_RANGES ranges,
// so past them a cold day lists none: a cold day takes no batch, so its
// missing ranges only say what will stay missing. See spec
// apinrdw/kumora#556, "Hot and cold days".
const storedStatus = Effect.fnUntraced(function* (
  bucket: DayBucket,
  date: WibDate,
  after: number
) {
  const { status: key } = yield* dayKeys(date)
  const stored = yield* Effect.promise(() => bucket.get(key))
  if (stored === null) return undefined
  const status = yield* decodeBrokerCodesStatus(
    yield* currentStatusText(
      yield* Effect.promise(() => new Response(stored.body).text())
    )
  )
  return {
    ...status,
    missing: status.missing.flatMap(([first, last]) =>
      Number(last) > after
        ? [
            [
              Number(first) > after
                ? first
                : TradeNumber.make(String(after + 1)),
              last,
            ] as const,
          ]
        : []
    ),
  }
}, Effect.orDie)

// A broker codes batch of a day whose move's first step ran: checked as
// any, then answered as taken while nothing is written.
export const takenUnwritten = Effect.fnUntraced(function* (
  text: string,
  date: WibDate
) {
  const batch = yield* checkedBatch(text, date)
  return batch instanceof Response ? batch : yield* noStoreAnswer(200)
})

// A cold day's object, emptied once its move marked it cold: it answers
// recorded day GETs from R2, a broker codes batch as taken while writing
// nothing, the status GET from the final status the move stored, and the
// next trading day's ask for its values from the values the move stored
// (404 for a day moved before they were).
// Decision: the emptied object answers from R2 itself, so a Worker isolate
// that still counts the day hot for a minute (COLD_DAYS_KEPT_MS in days.ts)
// reaches the same answers, and the move empties the object as soon as the
// index marks it cold. See spec apinrdw/kumora#556, "The move".
// `bucket` is read for each answer, from the request it answers.
export const coldDay = (
  date: WibDate,
  bucket: Effect.Effect<DayBucket, never, WorkerEnv>
) => ({
  recorded: Effect.fnUntraced(function* (resource: RecordedResource) {
    const answer = yield* coldAnswer(yield* bucket, date, resource)
    return answer ?? (yield* notStored)
  }),
  post: (text: string) => takenUnwritten(text, date),
  dayValues: Effect.flatMap(bucket, (days) => coldDayValues(days, date)),
  status: Effect.fnUntraced(function* (search: URLSearchParams) {
    const after = yield* brokerCodesAfter(search)
    if (Option.isNone(after)) return yield* noStoreAnswer(400, "Bad after")
    const status = yield* storedStatus(yield* bucket, date, after.value)
    if (status === undefined) return yield* notStored
    return yield* noStoreAnswer(
      200,
      yield* Effect.orDie(encodeBrokerCodesStatus(status)),
      { "Content-Type": "application/json" }
    )
  }),
})

export type ColdDay = ReturnType<typeof coldDay>
