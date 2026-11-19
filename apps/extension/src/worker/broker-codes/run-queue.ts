// The broker codes run queue (spec apinrdw/kumora#244, "The extension: the
// run queue"): what starts a run, and the order its walks go in. One run at
// a time; a trigger during a run starts one more after it.
import { Feed, WibDate } from "@workspace/relay"
import { Data, type DateTime, Effect, Option, Queue, Schema } from "effect"

import {
  RECENT_DAYS,
  inStreamingHours,
  newestClosedDay,
  recentClosedDays,
  scheduleNow,
  tradingDaysBetween,
} from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import type { StatusOutcome } from "./status.ts"

// Why walks stopped in place until something changes: Streaming hours,
// no broker tab of the walk's site, the Production target refused the batches
// (no token, a rejected token, a version the dashboard no longer takes),
// the owner's Pause, or Stockbit's tab signed out, which its walk waits on
// in place (progress.ts).
const PauseCause = Schema.Literals([
  "streaming-hours",
  "no-tab",
  "no-token",
  "rejected-token",
  "reload-extension",
  "paused",
  "signed-out",
])
export type PauseCause = typeof PauseCause.Type

// How one walk of a day ended:
// - walked: its site served the day to its end;
// - unserved: its site can't serve the day, and the next walk takes it;
//   `no-rows` is Stockbit answering the day with no rows, which gives it up;
//   `incomplete` is a gap walk that fetched every gap and still left the
//   day incomplete, which a later run walks again;
// - stopped: it stopped in place, and the run ends until the next trigger.
export type WalkResult =
  | { readonly _tag: "walked" }
  | {
      readonly _tag: "unserved"
      readonly reason: "window-passed" | "no-rows" | "incomplete"
    }
  | { readonly _tag: "stopped"; readonly cause: PauseCause }

// A walk ends before the day does (ajaib-walk.ts, stockbit-walk.ts).
class Halt extends Data.TaggedError("Halt")<{
  readonly result: WalkResult
}> {}
export const halt = (result: WalkResult) => Effect.fail(new Halt({ result }))

// A target's refusal of a post or a status read halts the walk: no token
// set, a rejected token, or a version the dashboard no longer takes.
export const haltOnRefusal = (outcome: Exclude<PostOutcome, "sent">) =>
  halt({
    _tag: "stopped",
    cause: outcome === "off" ? "no-token" : outcome,
  })

// Runs a walk, its halt as the walk's result.
export const settle = <R>(walk: Effect.Effect<WalkResult, Halt, R>) =>
  Effect.catchTag(walk, "Halt", (stop) => Effect.succeed(stop.result))

// One site's walk of a day.
export interface DayWalk {
  readonly feed: Feed
  readonly walk: (day: WibDate) => Effect.Effect<WalkResult>
}

// One site's catch-up walk of a day on the extra target (extra-target.ts).
// Its stop has no cause: it ends the catch-up only, and what stops the
// extra target shows in its Target state.
export type CatchUpResult =
  | Exclude<WalkResult, { readonly _tag: "stopped" }>
  | { readonly _tag: "stopped" }
export interface CatchUpWalk {
  readonly feed: Feed
  readonly walk: (day: WibDate) => Effect.Effect<CatchUpResult>
}

// What the queue is doing, for the options page: nothing, walking a day on
// a site, catching the extra target up, or paused. A walk is of the newest
// closed day, an older day's gaps, or a History day (history.ts). A walk
// that has fetched trades says how many, of the day's N once known, and its
// pace (progress.ts). Ajaib's walk in its repair pass says how many blocks
// it has walked again, of those it had left when it started or restarted,
// and their pace; its trades are then the first pass's last. A catch-up's
// end reports idle, which has the options page ask the days again, so a day
// it caught up no longer shows Behind.
export const BrokerCodesProgress = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({
    state: Schema.Literal("walking"),
    walk: Schema.Literals(["newest", "gaps", "history"]),
    day: WibDate,
    feed: Feed,
    trades: Schema.optionalKey(
      Schema.Struct({
        fetched: Schema.Finite,
        of: Schema.NullOr(Schema.Finite),
        perSecond: Schema.NullOr(Schema.Finite),
      })
    ),
    repair: Schema.optionalKey(
      Schema.Struct({
        done: Schema.Finite,
        of: Schema.Finite,
        perSecond: Schema.NullOr(Schema.Finite),
      })
    ),
  }),
  Schema.Struct({ state: Schema.Literal("catching-up") }),
  Schema.Struct({ state: Schema.Literal("paused"), cause: PauseCause }),
])
export type BrokerCodesProgress = typeof BrokerCodesProgress.Type

// The days that may still be incomplete, kept across restarts
// (settings.ts): each newest closed day joins it with the evenings missed
// since the last one, as does a History day left incomplete (history.ts).
// A day leaves once its gap walk finds it complete or Stockbit gives it up.
export interface IncompleteDaysStore {
  readonly load: Effect.Effect<ReadonlyArray<WibDate>>
  readonly save: (days: ReadonlyArray<WibDate>) => Effect.Effect<void>
  // The newest closed day the last run walked.
  readonly lastNewest: Effect.Effect<Option.Option<WibDate>>
  readonly saveLastNewest: (day: WibDate) => Effect.Effect<void>
}

// Adds days to the list, once each.
export const joinIncomplete = Effect.fnUntraced(function* (
  store: IncompleteDaysStore,
  days: ReadonlyArray<WibDate>
) {
  const kept = yield* store.load
  const added = days.filter((day) => !kept.includes(day))
  if (added.length > 0) yield* store.save([...kept, ...added])
})

export const makeRunQueue = Effect.fnUntraced(function* (options: {
  // The newest closed day's walks, in order: each runs once the one before
  // it walked the day or couldn't serve it.
  readonly newestDay: ReadonlyArray<DayWalk>
  readonly incompleteDays: IncompleteDaysStore
  // A day's status on Production (status.ts).
  readonly status: (day: WibDate) => Effect.Effect<StatusOutcome>
  // Stockbit's gap walk of an older incomplete day (stockbit-walk.ts).
  readonly gaps: DayWalk
  // The History walk of the days before the newest closed one, and the
  // extra target's catch-up of it (history.ts).
  readonly history: {
    readonly walk: (newest: WibDate) => Effect.Effect<Option.Option<PauseCause>>
    readonly catchUp: (newest: WibDate) => Effect.Effect<void>
  }
  // The extra target's catch-up of the newest closed day, in the same order:
  // walks that post only to the extra target, only what it misses
  // (extra-target.ts).
  readonly catchUp: ReadonlyArray<CatchUpWalk>
  // Then its gap walk of each older incomplete day, from its own status.
  readonly gapsCatchUp: CatchUpWalk
  // The owner's Pause switch as it stands now (settings.ts).
  readonly paused: Effect.Effect<boolean>
  readonly report: (progress: BrokerCodesProgress) => Effect.Effect<void>
}) {
  const wakes = yield* Queue.sliding<void>(1)
  const trigger = Effect.asVoid(Queue.offer(wakes, undefined))
  const pauses = yield* Queue.sliding<void>(1)

  // The extra target's walks: a stop ends the catch-up only, since
  // Production isn't paused.
  // Decision: after the newest closed day, the extra target walks the gaps
  // of the older days that were incomplete as the run began, newest first,
  // so it also gets the days Production completed in this run. A day
  // Production completed in an earlier run, while the extra target failed,
  // isn't walked again. See apinrdw/kumora#244, "Targets".
  const catchUp = Effect.fnUntraced(function* (
    day: WibDate,
    older: ReadonlyArray<WibDate>
  ) {
    for (const { walk } of options.catchUp) {
      const result = yield* walk(day)
      if (result._tag === "stopped") return
    }
    for (const each of older) {
      const result = yield* options.gapsCatchUp.walk(each)
      if (result._tag === "stopped") return
    }
  })

  // Decision: each run checks the last RECENT_DAYS days before the newest
  // on Production and joins each one that holds trades but is incomplete.
  // A day can leave the list complete and fall short later, as #437's held
  // rule left the days walked before it. A day holding nothing is the
  // History walk's; a refusal ends the check. See apinrdw/kumora#455.
  const recentIncomplete = Effect.fnUntraced(function* (
    now: DateTime.DateTime,
    newest: WibDate
  ) {
    const days: Array<WibDate> = []
    for (const day of yield* recentClosedDays(now, RECENT_DAYS)) {
      if (day >= newest) continue
      const status = yield* options.status(day)
      if (typeof status === "string") break
      const held = status.sources.ajaib + status.sources.stockbit
      if (!status.complete && (status.n !== null || held > 0)) days.push(day)
    }
    return days
  })

  // Decision: each run's newest closed day joins the list with every
  // trading day since the last run's newest, so the evenings a closed
  // browser missed are walked from Stockbit. A first run adds only its own
  // day; the History walk covers the days before it. See
  // apinrdw/kumora#244, "Order on each run".
  const joinNewest = Effect.fnUntraced(function* (
    now: DateTime.DateTime,
    newest: WibDate
  ) {
    const store = options.incompleteDays
    const last = yield* store.lastNewest
    const missed = Option.isSome(last)
      ? yield* tradingDaysBetween(last.value, newest)
      : []
    const fallenShort = yield* recentIncomplete(now, newest)
    yield* joinIncomplete(store, [...missed, ...fallenShort, newest])
    yield* store.saveLastNewest(newest)
  })

  // Decision: older incomplete days' gaps go newest first, each once a run,
  // so the days the options page lists fill before History's (2026-11-17).
  // A day leaves the list once its gap walk finds it complete or Stockbit
  // answers it with no rows; any other end keeps it for a later run. See
  // apinrdw/kumora#244, "Order on each run".
  const olderDays = Effect.fnUntraced(function* (days: ReadonlyArray<WibDate>) {
    for (const day of days) {
      yield* options.report({
        state: "walking",
        walk: "gaps",
        day,
        feed: options.gaps.feed,
      })
      const result = yield* options.gaps.walk(day)
      if (result._tag === "stopped") return Option.some(result.cause)
      if (
        result._tag === "walked" ||
        (result._tag === "unserved" && result.reason === "no-rows")
      ) {
        const kept = yield* options.incompleteDays.load
        yield* options.incompleteDays.save(kept.filter((each) => each !== day))
      }
    }
    return Option.none<PauseCause>()
  })

  const runOnce = Effect.gen(function* () {
    const now = yield* scheduleNow
    if (yield* inStreamingHours(now))
      return yield* options.report({
        state: "paused",
        cause: "streaming-hours",
      })
    const day = yield* newestClosedDay(now)
    if (Option.isNone(day)) return yield* options.report({ state: "idle" })
    yield* joinNewest(now, day.value)
    const older = [...(yield* options.incompleteDays.load)]
      .filter((each) => each < day.value)
      .sort()
      .reverse()
    for (const { feed, walk } of options.newestDay) {
      yield* options.report({
        state: "walking",
        walk: "newest",
        day: day.value,
        feed,
      })
      const result = yield* walk(day.value)
      if (result._tag === "stopped")
        return yield* options.report({ state: "paused", cause: result.cause })
    }
    const stopped = yield* olderDays(older)
    if (Option.isSome(stopped))
      return yield* options.report({ state: "paused", cause: stopped.value })
    const history = yield* options.history.walk(day.value)
    if (Option.isSome(history))
      return yield* options.report({ state: "paused", cause: history.value })
    // Decision: the extra target catches up once Production's queue is
    // empty, and gives way to the next trigger, which interrupts it and is
    // offered again so its run starts at once. The walks resume as after a
    // restart, and a failing extra target, whose posts retry for ever,
    // holds nothing up. See apinrdw/kumora#250.
    yield* options.report({ state: "catching-up" })
    yield* Effect.raceFirst(
      Effect.all([
        catchUp(day.value, older),
        options.history.catchUp(day.value),
        options.report({ state: "idle" }),
      ]),
      Effect.andThen(Queue.take(wakes), trigger)
    )
  })
  // Decision: Pause interrupts the run in progress, the extra target's
  // catch-up included, and every trigger after it runs nothing until the
  // switch is off. Walks stop in place and resume as after a restart.
  // Resume is a trigger. See apinrdw/kumora#244, "Pause".
  const ownerPaused = options.report({ state: "paused", cause: "paused" })
  const run = Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(wakes)
      yield* Queue.clear(pauses)
      if (yield* options.paused) return yield* ownerPaused
      yield* Effect.raceFirst(
        runOnce,
        Effect.andThen(Queue.take(pauses), ownerPaused)
      )
    })
  )

  // The switch turned on: stops the run in progress, and reports the pause
  // when none is.
  const pause = Effect.andThen(Queue.offer(pauses, undefined), trigger)

  // Decision: the first tick on which a new day is the newest closed one
  // starts a run: the first tick after 16:35 on a trading day, and the
  // worker's first tick after it starts. See apinrdw/kumora#244, "Triggers".
  let ticked = Option.none<WibDate>()
  const tick = Effect.gen(function* () {
    const day = yield* newestClosedDay(yield* scheduleNow)
    if (Option.isNone(day)) return
    if (Option.isSome(ticked) && ticked.value === day.value) return
    ticked = day
    yield* trigger
  })

  return { run, trigger, pause, tick }
})
