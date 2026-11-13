// The broker codes run queue (spec apinrdw/kumora#244, "The extension: the
// run queue"): what starts a run, and the order its walks go in. One run at
// a time; a trigger during a run starts one more after it.
import { Feed, WibDate } from "@workspace/relay"
import { DateTime, Effect, Option, Queue, Schema } from "effect"

import { isMarketHours, newestClosedDay } from "./hours.ts"

// Why walks stopped in place until something changes: market hours, or the
// Production target refused the batches (no token, a rejected token, a
// version the dashboard no longer takes).
const PauseCause = Schema.Literals([
  "market-hours",
  "no-token",
  "rejected-token",
  "reload-extension",
])
export type PauseCause = typeof PauseCause.Type

// How one walk of a day ended:
// - walked: its site served the day to its end;
// - unserved: its site can't serve the day, and the next walk takes it;
// - stopped: it stopped in place, and the run ends until the next trigger.
export type WalkResult =
  | { readonly _tag: "walked" }
  | {
      readonly _tag: "unserved"
      readonly reason: "no-tab" | "window-passed" | "other-date"
    }
  | { readonly _tag: "stopped"; readonly cause: PauseCause }

// One site's walk of a day.
export interface DayWalk {
  readonly feed: Feed
  readonly walk: (day: WibDate) => Effect.Effect<WalkResult>
}

// What the queue is doing, for the options page: nothing, walking a day on
// a site, or paused.
export const BrokerCodesProgress = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({ state: Schema.Literal("walking"), day: WibDate, feed: Feed }),
  Schema.Struct({ state: Schema.Literal("paused"), cause: PauseCause }),
])
export type BrokerCodesProgress = typeof BrokerCodesProgress.Type

export const makeRunQueue = Effect.fnUntraced(function* (options: {
  // The newest closed day's walks, in order: each runs once the one before
  // it walked the day or couldn't serve it.
  readonly newestDay: ReadonlyArray<DayWalk>
  readonly report: (progress: BrokerCodesProgress) => Effect.Effect<void>
}) {
  const wakes = yield* Queue.sliding<void>(1)
  const trigger = Effect.asVoid(Queue.offer(wakes, undefined))

  const runOnce = Effect.gen(function* () {
    const now = yield* DateTime.now
    if (yield* isMarketHours(now))
      return yield* options.report({ state: "paused", cause: "market-hours" })
    const day = yield* newestClosedDay(now)
    if (Option.isNone(day)) return yield* options.report({ state: "idle" })
    for (const { feed, walk } of options.newestDay) {
      yield* options.report({ state: "walking", day: day.value, feed })
      const result = yield* walk(day.value)
      if (result._tag === "stopped")
        return yield* options.report({ state: "paused", cause: result.cause })
    }
    yield* options.report({ state: "idle" })
  })
  const run = Effect.forever(Effect.andThen(Queue.take(wakes), runOnce))

  // Decision: the first tick on which a new day is the newest closed one
  // starts a run: the first tick after 16:35 on a trading day, and the
  // worker's first tick after it starts. See apinrdw/kumora#244, "Triggers".
  let ticked = Option.none<WibDate>()
  const tick = Effect.gen(function* () {
    const day = yield* newestClosedDay(yield* DateTime.now)
    if (Option.isNone(day)) return
    if (Option.isSome(ticked) && ticked.value === day.value) return
    ticked = day
    yield* trigger
  })

  return { run, trigger, tick }
})
