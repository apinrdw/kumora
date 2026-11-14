// A trading day's recorded day GETs (spec apinrdw/kumora#138, "Recorded day
// loads"), answered from its day store. A day not sealed yet answers what it
// flushed, not cached; a sealed day's answers never change.
import {
  encodeRecordedCandles,
  encodeRecordedGaps,
  encodeRecordedSweeps,
  encodeRecordedTape,
  type RecordedResource,
  type RecordedSweeps,
  type RelayGap,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import { codeListAnswer, type CodeListStore } from "./code-list.ts"
import { Fact, type makeDayStore } from "./day-store.ts"
import { heatmapAnswer, type HeatRow } from "./heat-rows.ts"
import { SEALED_CACHE } from "./routes.ts"

// The newest trades a viewer's snapshot carries, and a tape GET at a cursor.
export const SNAPSHOT_TRADES = 200

const MINUTE = 60_000

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

export const recordedAnswer = Effect.fnUntraced(function* (
  resource: RecordedResource,
  day: {
    readonly date: WibDate
    readonly store: Effect.Success<ReturnType<typeof makeDayStore>>
    readonly codeList: CodeListStore
    readonly sealed: boolean
    // The gaps so far, while the day isn't sealed.
    readonly liveGaps: Effect.Effect<ReadonlyArray<RelayGap>>
    // A code's heatmap rows not stored yet, each slice ending by `through`.
    readonly heldHeat: (
      code: StockCode,
      through: number
    ) => Effect.Effect<ReadonlyArray<HeatRow>>
    // A code's sweeps so far, with the trade number they were built up to.
    readonly sweeps: (
      code: StockCode
    ) => Effect.Effect<Omit<RecordedSweeps, "code">>
  }
) {
  const { store } = day
  const cacheControl = day.sealed ? SEALED_CACHE : "no-store"
  switch (resource._tag) {
    case "Codes":
      return yield* codeListAnswer(day.codeList, day.date)
    case "Tape":
      return yield* json(
        yield* encodeRecordedTape({
          trades: yield* store.tradesAt(resource.at, SNAPSHOT_TRADES),
        }),
        cacheControl
      )
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
          ...(yield* day.sweeps(resource.code)),
        }),
        cacheControl
      )
    case "Book": {
      const minute =
        Math.floor(DateTime.toEpochMillis(resource.minute) / MINUTE) * MINUTE
      const chunk = yield* store.chunkAt(resource.code, minute)
      return chunk === undefined
        ? yield* json(
            '{"error":"NotFound","message":"Not recorded"}',
            cacheControl,
            404
          )
        : yield* json(chunk, cacheControl)
    }
    case "Heatmap": {
      const { code } = resource
      return yield* json(
        yield* heatmapAnswer(
          code,
          yield* store.heatmapOf(code),
          day.sealed
            ? undefined
            : {
                now: yield* Clock.currentTimeMillis,
                held: (through) => day.heldHeat(code, through),
              }
        ),
        cacheControl
      )
    }
    case "Gaps":
      return yield* json(
        day.sealed
          ? ((yield* store.fact(Fact.gaps)) ?? '{"gaps":[]}')
          : yield* encodeRecordedGaps({ gaps: yield* day.liveGaps }),
        cacheControl
      )
  }
})
