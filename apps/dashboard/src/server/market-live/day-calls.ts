// The calls one Durable Object or the reconcile cron makes to another: a
// poke to a day's object, and the day index's strip and posts. Each runs on
// the request's WorkerEnv.
import { decodeDayStrip, type WibDate } from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { Effect, Schema } from "effect"

import {
  DAY_INDEX,
  DayIndexPath,
  type DayIndexColdPath,
  type ObjectPath,
} from "./routes.ts"

// A trading-day object answered a poke with neither 202 nor 204.
class PokeRefused extends Schema.TaggedError<PokeRefused>()("PokeRefused", {
  path: Schema.String,
  status: Schema.Int,
}) {}

// POSTs `path` to `day`'s object: true on 202, false on 204.
export const pokeDay = (path: (typeof ObjectPath)["brokerTotals" | "move"]) =>
  Effect.fnUntraced(function* (day: WibDate) {
    const object = (yield* WorkerEnv).TRADING_DAY.getByName(day)
    const response = yield* Effect.tryPromise((): Promise<Response> =>
      object.fetch(new URL(path, "https://trading-day.invalid"), {
        method: "POST",
      })
    )
    if (response.status === 202) return true
    if (response.status === 204) return false
    return yield* new PokeRefused({ path, status: response.status })
  })

const dayIndex = Effect.gen(function* () {
  return (yield* WorkerEnv).MARKET_LIVE_INDEX.getByName(DAY_INDEX)
})

// The day index's rows.
export const stripDays = Effect.gen(function* () {
  const index = yield* dayIndex
  const response = yield* Effect.promise((): Promise<Response> =>
    index.fetch(new URL(DayIndexPath, "https://day-index.invalid"))
  )
  const strip = yield* decodeDayStrip(
    yield* Effect.promise(() => response.text())
  )
  return strip.days
})

// The index didn't take a post; its sender retries.
class IndexRefused extends Schema.TaggedError<IndexRefused>()("IndexRefused", {
  path: Schema.String,
  status: Schema.Int,
}) {}

// POSTs `body` to the day index at `path`: a sealed day's row, or a moved
// day's date to mark it cold.
export const postToIndex = Effect.fnUntraced(function* (
  path: typeof DayIndexPath | typeof DayIndexColdPath,
  body: string
) {
  const index = yield* dayIndex
  const response = yield* Effect.tryPromise((): Promise<Response> =>
    index.fetch(new URL(path, "https://day-index.invalid"), {
      method: "POST",
      body,
    })
  )
  if (!response.ok)
    return yield* new IndexRefused({ path, status: response.status })
})
