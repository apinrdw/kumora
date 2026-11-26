// The extra target (Staging, a Preview or a Dev stage) for broker codes
// (spec apinrdw/kumora#244, "The extension: targets"). Production drives the
// walks: each batch a walk builds goes to Production and is handed to the
// extra target without waiting on it. Whatever the extra target misses, it
// catches up from its own status once Production's queue is empty.
import type { StageUrl } from "@workspace/deploy/stage-url"
import type {
  BrokerCodesBatch,
  BrokerCodesStatus,
  Feed,
  OrderNumberCounts,
  TradeNumber,
  WibDate,
} from "@workspace/relay"
import { Effect, Option, Queue } from "effect"

import {
  makeBrokerCodesPoster,
  type BrokerCodesTarget,
  type PostOutcome,
  type Send,
} from "./poster.ts"
import type { CatchUpResult, CatchUpWalk, WalkResult } from "./run-queue.ts"
import { askStatus, statusOnce, type Get } from "./status.ts"
import type { TargetHold } from "./target-hold.ts"

// The batches handed to the extra target wait in a lane of 16
// (~80,000 trades at Ajaib's 5,000 a batch). A batch past that is dropped,
// as is one being sent when the settings change; the catch-ups send what
// either left out. A lane that kept every batch of an unreachable target
// would hold a whole day's codes. See apinrdw/kumora#250.
const LANE = 16

// A site's walk of a day for the extra target's order number catch-up,
// over its post.
type OrdersWalk = (
  day: WibDate,
  post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
) => Effect.Effect<WalkResult>

// Whether the target lacks a trade, from a status that lists from trade 1:
// one in a missing range, or past the highest it holds. While its `n` is
// unknown, that is known only as the trade just past its last range, as a
// range ends below a trade held: a codes-only row counts in both `sources`
// and the ranges. A list cut short at MISSING_RANGES counts every trade past
// its last range as lacked. Either way the catch-up resends some trades the
// target holds, which changes nothing.
const lacks = (status: BrokerCodesStatus) =>
  Effect.sync(() => {
    const ranges = status.missing.map(
      ([from, to]) => [Number(from), Number(to)] as const
    )
    const listed = ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0)
    const last = ranges.at(-1)?.[1]
    const highest =
      listed < status.missingCount
        ? (last ?? 0)
        : status.n === null
          ? last === undefined
            ? 0
            : last + 1
          : Number(status.n)
    return (number: TradeNumber) => {
      const trade = Number(number)
      return (
        trade > highest ||
        ranges.some(([from, to]) => trade >= from && trade <= to)
      )
    }
  })

// Whether two statuses, each listing from trade 1, hold the same trades of a
// day. Two lists cut short at MISSING_RANGES compare by their first ranges
// and their counts alone.
export const holdsSame = (a: BrokerCodesStatus, b: BrokerCodesStatus) =>
  Effect.sync(
    () =>
      a.n === b.n &&
      a.sources.ajaib + a.sources.stockbit ===
        b.sources.ajaib + b.sources.stockbit &&
      a.missingCount === b.missingCount &&
      JSON.stringify(a.missing) === JSON.stringify(b.missing)
  )

export const makeExtraTarget = Effect.fnUntraced(function* (options: {
  // Production as its settings stand now, whose status the catch-up
  // compares with the extra target's.
  readonly production: Effect.Effect<Option.Option<BrokerCodesTarget>>
  readonly send: Send
  readonly get: Get
  // The extra target's settings and its state under them (target-hold.ts).
  readonly hold: TargetHold
}) {
  const { hold } = options
  // A request the extra target fails, by a status other than 401
  // or 426 or by none (0: a network or CORS failure), shows it as retrying
  // until one goes through, so a target the browser can't reach is never
  // retried unseen. See apinrdw/kumora#244, "Retries".
  // The answer is judged by the settings the request went out on, which
  // the hold ignores once they no longer hold.
  const send: Send = (request) =>
    Effect.tap(options.send(request), (status) =>
      hold.answered(request.target, status)
    )
  const get: Get = (request) =>
    Effect.tap(options.get(request), ({ status }) =>
      hold.answered(request.target, status)
    )
  const lane = yield* Queue.dropping<BrokerCodesBatch>(LANE)

  // Decision: 401 refuses the token, 426 means reload the extension
  // (packages/relay/docs/adr/0002-broker-codes-refusals-401-refuses-the-token-426-means-reload.md)
  const postTo = Effect.fnUntraced(function* (
    target: Option.Option<BrokerCodesTarget>,
    batch: BrokerCodesBatch
  ) {
    if (Option.isNone(target)) return "off" satisfies PostOutcome
    const poster = yield* makeBrokerCodesPoster({
      target: Effect.succeed(target),
      send,
      refused: hold.refused,
      halted: hold.haltOf,
    })
    return yield* poster.post(batch)
  })

  // The extra target's status of a day on `target`, listing the missing
  // ranges after `after`; none when it is unset, halted, refused the read
  // (which stops it, as a post's refusal does), didn't answer, or was halted
  // while it read.
  const statusOn = Effect.fnUntraced(function* (
    target: Option.Option<BrokerCodesTarget>,
    day: WibDate,
    after?: TradeNumber
  ) {
    if (
      Option.isNone(target) ||
      Option.isSome(yield* hold.haltOf(target.value))
    )
      return Option.none<BrokerCodesStatus>()
    const asked = yield* askStatus(get, target.value, day, after)
    if (Option.isSome(asked) && typeof asked.value === "string")
      yield* hold.refused(target.value, asked.value)
    if (Option.isSome(yield* hold.haltOf(target.value)))
      return Option.none<BrokerCodesStatus>()
    return Option.filter(asked, (held) => typeof held !== "string")
  })

  // The URL of `target` while the hold lets it go on.
  const urlWhile = (target: Option.Option<BrokerCodesTarget>) =>
    Option.match(target, {
      onNone: () => Effect.succeed(Option.none<StageUrl>()),
      onSome: (own) =>
        Effect.map(hold.haltOf(own), (halt) =>
          Option.isSome(halt) ? Option.none() : Option.some(own.url)
        ),
    })

  // Whether the extra target, holding `held` of a day, is behind on it: the
  // day isn't complete, and Production's status, when it answers one, holds
  // trades the extra target lacks. A catch-up can only send what the sites
  // gave Production, so an extra target that lacks exactly what Production
  // lacks has nothing to catch up.
  const behind = Effect.fnUntraced(function* (
    day: WibDate,
    held: BrokerCodesStatus
  ) {
    if (held.complete) return false
    const production = yield* options.production
    if (Option.isNone(production)) return true
    const leading = yield* statusOnce(options.get, production.value, day)
    return !(Option.isSome(leading) && (yield* holdsSame(leading.value, held)))
  })

  // Production's order number counts of a day; none when it is unset or
  // gave no status.
  const leadingOrders = Effect.fnUntraced(function* (day: WibDate) {
    const production = yield* options.production
    if (Option.isNone(production)) return Option.none<OrderNumberCounts>()
    const leading = yield* statusOnce(options.get, production.value, day)
    return Option.map(leading, (status) => status.orderNumbers)
  })

  return {
    // Sends the lane's batches to the extra target, one at a time, each
    // resent until it is written or its settings halt.
    run: Effect.forever(
      Effect.gen(function* () {
        const batch = yield* Queue.take(lane)
        yield* postTo(yield* hold.settings, batch)
      })
    ),

    // Production's post, also handing each batch to the extra target. A walk
    // sees only Production's outcome.
    tee:
      (production: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>) =>
      (batch: BrokerCodesBatch) =>
        Effect.andThen(Queue.offer(lane, batch), production(batch)),

    // Order numbers land on trades the extra target may hold already, from
    // the Done Details walk or Stockbit's, so the trade catch-up never
    // resends a batch of them its lane dropped. `walks` post to it: the Done
    // Details walk its held matched trades, Stockbit's walk its whole day.
    // The extra target converges on Production's order number
    // counts: fewer with Ajaib's has the Done Details walk post its held
    // trades again, then fewer in all has Stockbit's day walked whole. No
    // batch is kept until the extra target takes it: that would hold a day
    // for an unreachable target. See apinrdw/kumora#632.
    ordersCatchUp: (walks: {
      readonly ajaib: OrdersWalk
      readonly stockbit: OrdersWalk
    }): CatchUpWalk => ({
      walk: Effect.fnUntraced(function* (day: WibDate) {
        const stopped: CatchUpResult = { _tag: "stopped" }
        const walking = yield* hold.settings
        const post = (batch: BrokerCodesBatch) => postTo(walking, batch)
        const before = yield* statusOn(walking, day)
        if (Option.isNone(before)) return stopped
        const leading = yield* leadingOrders(day)
        if (Option.isNone(leading))
          return { _tag: "walked" } satisfies CatchUpResult
        let held = before.value.orderNumbers
        if (held.ajaib < leading.value.ajaib) {
          if ((yield* walks.ajaib(day, post))._tag === "stopped") return stopped
          const after = yield* statusOn(walking, day)
          if (Option.isNone(after)) return stopped
          held = after.value.orderNumbers
        }
        if (
          held.ajaib + held.stockbit >=
          leading.value.ajaib + leading.value.stockbit
        )
          return { _tag: "walked" } satisfies CatchUpResult
        const result = yield* walks.stockbit(day, post)
        return result._tag === "stopped" ? stopped : result
      }),
    }),

    // The extra target's URL while its settings go on, for the History
    // catch-up's store (settings.ts).
    url: Effect.flatMap(hold.settings, urlWhile),

    // A site's catch-up walk for the run queue: `make` builds the site's
    // walk over a post and a status read on the settings the walk captured,
    // the post sending only the trades its status, read as the walk starts,
    // says it lacks, and over their URL for the walk's store. The walk is
    // skipped unless the target is behind, and stops, having caught up
    // nothing, when the target is unset, halted or gave no status. A stop,
    // the site walk's too, is passed on without its cause.
    catchUp: Effect.fnUntraced(function* <E, R>(
      feed: Feed,
      make: (target: {
        readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
        readonly status: (
          day: WibDate,
          after?: TradeNumber
        ) => Effect.Effect<Option.Option<BrokerCodesStatus>>
        readonly url: Effect.Effect<Option.Option<StageUrl>>
      }) => Effect.Effect<
        { readonly walk: (day: WibDate) => Effect.Effect<WalkResult> },
        E,
        R
      >
    ) {
      const stopped: CatchUpResult = { _tag: "stopped" }
      let walking = Option.none<BrokerCodesTarget>()
      let wanted = (_number: TradeNumber) => true
      const walk = yield* make({
        post: (batch) =>
          Effect.suspend(() => {
            const rows = batch.rows.filter(([number]) => wanted(number))
            if (rows.length === 0 && batch.end === undefined)
              return Effect.succeed("sent" satisfies PostOutcome)
            return postTo(walking, { ...batch, rows })
          }),
        status: (day, after) =>
          Effect.suspend(() => statusOn(walking, day, after)),
        url: Effect.suspend(() => urlWhile(walking)),
      })
      return {
        feed,
        walk: Effect.fnUntraced(function* (day: WibDate) {
          walking = yield* hold.settings
          const held = yield* statusOn(walking, day)
          if (Option.isNone(held)) return stopped
          if (!(yield* behind(day, held.value)))
            return { _tag: "walked" } satisfies CatchUpResult
          wanted = yield* lacks(held.value)
          const result = yield* walk.walk(day)
          return result._tag === "stopped" ? stopped : result
        }),
      } satisfies CatchUpWalk
    }),
  }
})
