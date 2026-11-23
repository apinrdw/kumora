// A trading day's recorded day GETs (spec apinrdw/kumora#138, "Recorded day
// loads"), answered from its day store. A day not sealed yet answers what it
// flushed, not cached; a sealed day's answers never change, except the
// bubbles answer (bubblesAnswer): built once more after the seal, it 404s
// from midnight.
import {
  encodeRecordedBookEvents,
  encodeRecordedBrokerCodes,
  encodeRecordedCandles,
  encodeRecordedGaps,
  encodeRecordedOrderFlowEvents,
  encodeRecordedSweepBrokers,
  encodeRecordedSweeps,
  encodeRecordedTape,
  type BookEvent,
  type OrderFlowEvent,
  type RecordedResource,
  type RecordedSweeps,
  type RelayGap,
  type StockCode,
  type WibDate,
  MINUTE_MS,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import type { BrokerCodesStore } from "./broker-codes.ts"
import { codeListAnswer, type CodeListStore } from "./code-list.ts"
import { Fact, type makeDayStore } from "./day-store.ts"
import { heatEndOf } from "../../lib/heatmap.ts"
import { heatmapAnswer, type HeatRow } from "./heat-rows.ts"
import { SEALED_CACHE } from "./routes.ts"
import type { SweepBrokersStore } from "./sweep-brokers.ts"

// The newest trades a viewer's snapshot carries, and a tape GET at a cursor.
export const SNAPSHOT_TRADES = 200

// A complete day's codes answer is kept a minute, never immutable:
// a later Ajaib or Stockbit batch may still rewrite a trade's codes. An
// incomplete day's is not stored, so the page's recheck sees new codes.
const COMPLETE_CODES_CACHE = "private, max-age=60"

// The bubbles answer is kept a minute, its build's span (spec
// apinrdw/kumora#427, "Backfill GET").
const BUBBLES_CACHE = "private, max-age=60"

const json = (text: string, cacheControl: string, status = 200) =>
  Effect.sync(
    () =>
      new Response(text, {
        status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": cacheControl,
        },
      })
  )

// The bubbles answer, as last built: the live day only, its seal included.
// Owner, 2026-11-17: the live date's own body is still answered
// after its seal until midnight; past days 404. It replaces spec
// apinrdw/kumora#427's "Sealed day: ... answers 404". The sealed body keeps
// the live cache. See apinrdw/kumora#436.
export const bubblesAnswer = Effect.fnUntraced(function* <E>(
  past: boolean,
  body: Effect.Effect<string, E>
) {
  return past
    ? yield* json(
        '{"error":"NotFound","message":"Live day only"}',
        SEALED_CACHE,
        404
      )
    : yield* json(yield* body, BUBBLES_CACHE)
})

// What a day's recorded answers read.
interface RecordedDayOf {
  readonly date: WibDate
  readonly store: Effect.Success<ReturnType<typeof makeDayStore>>
  readonly codeList: CodeListStore
  readonly brokerCodes: BrokerCodesStore
  readonly sweepBrokers: SweepBrokersStore
  // Whether the day still takes broker codes.
  readonly takesCodes: Effect.Effect<boolean>
  readonly sealed: boolean
  // The gaps so far, while the day isn't sealed.
  readonly liveGaps: Effect.Effect<ReadonlyArray<RelayGap>>
  // A code's heatmap rows not stored yet, each slice ending by `through`.
  readonly heldHeat: (
    code: StockCode,
    through: number
  ) => Effect.Effect<ReadonlyArray<HeatRow>>
  // Whether the day did not record a code's order books
  // (recorded-books.ts).
  readonly booksNotRecorded: (code: StockCode) => Effect.Effect<boolean>
  // A code's sweeps so far.
  readonly sweeps: (code: StockCode) => Effect.Effect<RecordedSweeps["sweeps"]>
  // A code's book events so far, and whether the day records them.
  readonly bookEvents: (code: StockCode) => Effect.Effect<{
    readonly recorded: boolean
    readonly events: ReadonlyArray<BookEvent>
  }>
  // A code's order flow events so far, and whether the day records them.
  readonly orderFlowEvents: (code: StockCode) => Effect.Effect<{
    readonly recorded: boolean
    readonly events: ReadonlyArray<OrderFlowEvent>
  }>
}

export const recordedAnswer = Effect.fnUntraced(function* (
  resource: Exclude<RecordedResource, { readonly _tag: "Bubbles" }>,
  day: RecordedDayOf
) {
  const { store } = day
  const cacheControl = day.sealed ? SEALED_CACHE : "no-store"
  switch (resource._tag) {
    case "Codes":
      return yield* codeListAnswer(day.codeList, day.date)
    case "Tape":
      return yield* json(
        yield* encodeRecordedTape({
          trades: yield* store.tradesAt(resource, SNAPSHOT_TRADES),
        }),
        cacheControl
      )
    // Decision: broker codes and sweep brokers are their own resources, not immutable
    // (apps/dashboard/docs/adr/0093-late-arriving-broker-data-are-their-own-cached-resources.md)
    case "BrokerCodes": {
      const trades = yield* store.tradesAt(resource, SNAPSHOT_TRADES)
      const complete = yield* day.brokerCodes.codesComplete
      return yield* json(
        yield* encodeRecordedBrokerCodes({
          codes: yield* day.brokerCodes.heldCodes(
            trades.map((trade) => trade.tradeNumber)
          ),
          complete,
        }),
        complete ? COMPLETE_CODES_CACHE : "no-store"
      )
    }
    case "Candles": {
      const previous = (yield* store.livePrice(resource.code))?.previous
      return yield* json(
        yield* encodeRecordedCandles({
          code: resource.code,
          ...(previous === undefined ? {} : { previousClose: previous }),
          candles: yield* store.candlesOf(resource.code),
          footprints: yield* store.footprintsOf(resource.code),
        }),
        cacheControl
      )
    }
    case "Sweeps":
      return yield* json(
        yield* encodeRecordedSweeps({
          code: resource.code,
          sweeps: yield* day.sweeps(resource.code),
        }),
        cacheControl
      )
    // Decision: broker codes and sweep brokers are their own resources, not immutable
    // (apps/dashboard/docs/adr/0093-late-arriving-broker-data-are-their-own-cached-resources.md)
    case "SweepBrokers": {
      const complete = yield* day.brokerCodes.codesComplete
      return yield* json(
        yield* encodeRecordedSweepBrokers({
          code: resource.code,
          sweeps: yield* day.sweepBrokers.brokersOf(resource.code),
          complete,
          takesCodes: yield* day.takesCodes,
        }),
        complete ? COMPLETE_CODES_CACHE : "no-store"
      )
    }
    case "Book": {
      const minute =
        Math.floor(DateTime.toEpochMillis(resource.minute) / MINUTE_MS) *
        MINUTE_MS
      const chunk = yield* store.chunkAt(resource.code, minute)
      return chunk === undefined
        ? yield* json(
            '{"error":"NotFound","message":"Not recorded"}',
            cacheControl,
            404
          )
        : yield* json(chunk, cacheControl)
    }
    case "Heatmap":
      return yield* json(yield* heatmapOf(resource.code, day), cacheControl)
    // Decision: a day without a live reading answers its events not recorded
    // (apps/dashboard/docs/adr/0094-only-a-live-reading-marks-a-day-s-events-recorded.md)
    case "BookEvents":
      return yield* json(
        yield* encodeRecordedBookEvents({
          code: resource.code,
          ...(yield* day.bookEvents(resource.code)),
        }),
        cacheControl
      )
    // Decision: a day without a live reading answers its events not recorded
    // (apps/dashboard/docs/adr/0094-only-a-live-reading-marks-a-day-s-events-recorded.md)
    case "OrderFlowEvents":
      return yield* json(
        yield* encodeRecordedOrderFlowEvents({
          code: resource.code,
          ...(yield* day.orderFlowEvents(resource.code)),
        }),
        cacheControl
      )
    case "Gaps":
      return yield* json(
        day.sealed
          ? ((yield* store.fact(Fact.gaps)) ?? '{"gaps":[]}')
          : yield* encodeRecordedGaps({ gaps: yield* day.liveGaps }),
        cacheControl
      )
  }
})

// A code's heatmap answer: its stored rows, and a live day's held ones.
const heatmapOf = Effect.fnUntraced(function* (
  code: StockCode,
  day: RecordedDayOf
) {
  const stored = yield* day.store.heatmapOf(code)
  return yield* heatmapAnswer(
    code,
    stored,
    yield* heatEndOf(day.date),
    day.sealed
      ? undefined
      : {
          now: yield* Clock.currentTimeMillis,
          held: (through) => day.heldHeat(code, through),
        },
    stored.length === 0 && (yield* day.booksNotRecorded(code))
  )
})
