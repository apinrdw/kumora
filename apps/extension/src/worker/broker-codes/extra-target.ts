// The extra target (Staging, a Preview or a Dev stage) for broker codes
// (spec apinrdw/kumora#244, "The extension: targets"). Production drives the
// walks: each batch a walk builds goes to Production and is handed to the
// extra target without waiting on it. Whatever the extra target misses, it
// catches up from its own status once Production's queue is empty.
import {
  brokerCodesPath,
  decodeBrokerCodesStatus,
  type BrokerCodesBatch,
  type BrokerCodesStatus,
  type Feed,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option, Queue } from "effect"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type GetStatus,
  type PostOutcome,
  type Send,
} from "./poster.ts"
import type { DayWalk, WalkResult } from "./run-queue.ts"

// The outcomes that stop a target until its settings change.
type Stop = Extract<PostOutcome, "rejected-token" | "reload-extension">

// Decision: the batches handed to the extra target wait in a lane of 16
// (~80,000 trades at Ajaib's 5,000 a batch); past that a batch is dropped,
// and the catch-up sends it later. A lane that kept every batch of an
// unreachable target would hold a whole day's codes. See apinrdw/kumora#250.
const LANE = 16

// Whether the target lacks a trade: one in a missing range, or past the
// highest it holds. While its `n` is unknown, that is every trade it holds
// plus the missing ones below it.
const lacks = (status: BrokerCodesStatus) =>
  Effect.sync(() => {
    const ranges = status.missing.map(
      ([from, to]) => [Number(from), Number(to)] as const
    )
    const held = status.sources.ajaib + status.sources.stockbit
    const highest =
      status.n === null
        ? ranges.reduce((sum, [from, to]) => sum + to - from + 1, held)
        : Number(status.n)
    return (number: string) => {
      const trade = Number(number)
      return (
        trade > highest ||
        ranges.some(([from, to]) => trade >= from && trade <= to)
      )
    }
  })

// Whether two statuses hold the same trades of a day.
const holdsSame = (a: BrokerCodesStatus, b: BrokerCodesStatus) =>
  Effect.sync(
    () =>
      a.n === b.n &&
      a.sources.ajaib + a.sources.stockbit ===
        b.sources.ajaib + b.sources.stockbit &&
      JSON.stringify(a.missing) === JSON.stringify(b.missing)
  )

export const makeExtraTarget = Effect.fnUntraced(function* (options: {
  // The extra target as its settings stand now; none when unset or without
  // a token.
  readonly target: Effect.Effect<Option.Option<BrokerCodesTarget>>
  // Production as its settings stand now, whose status the catch-up
  // compares with the extra target's.
  readonly production: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
  readonly get: GetStatus
  // A 401 or a 426 stopped the target: its Target state.
  readonly report: (state: Stop) => Effect.Effect<void>
}) {
  const poster = yield* makeBrokerCodesPoster(options)
  const lane = yield* Queue.dropping<BrokerCodesBatch>(LANE)

  // The settings a 401 or 426 came back on, and which.
  let stopped = Option.none<{
    readonly target: BrokerCodesTarget
    readonly stop: Stop
  }>()

  // Decision: a 401 or 426 stops the extra target until its origin or token
  // changes; nothing is sent to it meanwhile. See apinrdw/kumora#244,
  // "Retries".
  const stopOf = (target: BrokerCodesTarget) =>
    Effect.sync(() =>
      Option.map(
        Option.filter(
          stopped,
          (held) =>
            held.target.origin === target.origin &&
            held.target.token === target.token
        ),
        (held) => held.stop
      )
    )

  const post = Effect.fnUntraced(function* (batch: BrokerCodesBatch) {
    const target = yield* options.target
    if (Option.isNone(target)) return "off" satisfies PostOutcome
    const stop = yield* stopOf(target.value)
    if (Option.isSome(stop)) return stop.value
    const outcome = yield* poster.post(batch)
    if (outcome === "rejected-token" || outcome === "reload-extension") {
      stopped = Option.some({ target: target.value, stop: outcome })
      yield* options.report(outcome)
    }
    return outcome
  })

  // A target's status of a day; none when it didn't answer one.
  const statusAt = Effect.fnUntraced(function* (
    target: BrokerCodesTarget,
    day: WibDate
  ) {
    const path = yield* brokerCodesPath(day)
    const body = yield* options.get({
      url: `${target.origin}${path}`,
      token: target.token,
    })
    if (Option.isNone(body)) return Option.none<BrokerCodesStatus>()
    return yield* Effect.option(decodeBrokerCodesStatus(body.value))
  })

  // The extra target's status of a day; none when it is unset, stopped or
  // didn't answer.
  const status = Effect.fnUntraced(function* (day: WibDate) {
    const target = yield* options.target
    if (Option.isNone(target) || Option.isSome(yield* stopOf(target.value)))
      return Option.none<BrokerCodesStatus>()
    return yield* statusAt(target.value, day)
  })

  // Whether the extra target is behind on a day: it answered a status that
  // isn't complete, and Production's status, when it answers one, holds
  // trades the extra target lacks. A catch-up can only send what the sites
  // gave Production, so an extra target that lacks exactly what Production
  // lacks has nothing to catch up.
  const behind = Effect.fnUntraced(function* (day: WibDate) {
    const held = yield* status(day)
    if (Option.isNone(held) || held.value.complete)
      return Option.none<BrokerCodesStatus>()
    const production = yield* options.production
    if (Option.isNone(production)) return held
    const leading = yield* statusAt(production.value, day)
    if (Option.isSome(leading) && (yield* holdsSame(leading.value, held.value)))
      return Option.none<BrokerCodesStatus>()
    return held
  })

  return {
    // Sends the lane's batches to the extra target, one at a time, each
    // resent until it is written or the target stops.
    run: Effect.forever(Effect.flatMap(Queue.take(lane), post)),

    // Production's post, also handing each batch to the extra target. A walk
    // sees only Production's outcome.
    tee:
      (production: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>) =>
      (batch: BrokerCodesBatch) =>
        Effect.andThen(Queue.offer(lane, batch), production(batch)),

    // A site's catch-up walk for the run queue: `make` builds the site's
    // walk over a post that sends the extra target only the trades its
    // status, read as the walk starts, says it lacks. The walk is skipped
    // unless the target is behind.
    catchUp: Effect.fnUntraced(function* <E, R>(
      feed: Feed,
      make: (target: {
        readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
        readonly status: typeof status
      }) => Effect.Effect<
        { readonly walk: (day: WibDate) => Effect.Effect<WalkResult> },
        E,
        R
      >
    ) {
      let wanted = (_number: string) => true
      const walk = yield* make({
        post: (batch) =>
          Effect.suspend(() => {
            const rows = batch.rows.filter(([number]) => wanted(number))
            if (rows.length === 0 && batch.end === undefined)
              return Effect.succeed("sent" satisfies PostOutcome)
            return post({ ...batch, rows })
          }),
        status,
      })
      return {
        feed,
        walk: Effect.fnUntraced(function* (day: WibDate) {
          const held = yield* behind(day)
          if (Option.isNone(held))
            return { _tag: "walked" } satisfies WalkResult
          wanted = yield* lacks(held.value)
          return yield* walk.walk(day)
        }),
      } satisfies DayWalk
    }),
  }
})
