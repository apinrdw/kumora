// One REST pacer per broker site (spec apinrdw/kumora#244, "The extension:
// shared REST pacing and throttling"). Every REST call the extension makes on
// a site goes through it: Market Live's backfill first, broker codes walks
// with what is left.
import type { Feed } from "@workspace/relay"
import { Clock, Deferred, Effect, Fiber, Option, Queue } from "effect"

import type { Answer, LocalRequest, TabRequest } from "./broker.ts"
import { REQUEST_TIMEOUT } from "./tab.ts"

// What the pacer hands its callers: a call answered, or none when the tab
// goes or doesn't answer in time.
export interface RequestingTab {
  readonly request: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
}

// What the pacer needs of a broker tab: the requests it answers itself, and
// a call waited for until the tab answers or goes.
interface AnsweringTab {
  readonly request: (
    request: LocalRequest
  ) => Effect.Effect<Option.Option<Answer>>
  readonly awaitAnswer: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
}

// A tab whose REST calls wait for the site's pace: only `makePacer` makes
// one, so a caller that takes it can't be handed the unpaced tab.
declare const pacedBrand: unique symbol
export interface PacedTab extends RequestingTab {
  readonly [pacedBrand]: true
}

// Who a call is for. Backfill calls start before any waiting walk call.
export type Priority = "backfill" | "walk"

// Decision: 3 calls a second per site; a throttle stops the site 5 minutes
// (apps/extension/docs/adr/0011-the-pacer-spaces-calls-and-backs-off-on-a-throttle.md)
const FULL_SPACING = 334
const HALF_SPACING = 2 * FULL_SPACING

// Decision: 3 calls a second per site; a throttle stops the site 5 minutes
// (apps/extension/docs/adr/0011-the-pacer-spaces-calls-and-backs-off-on-a-throttle.md)
const STOPPED_FOR = 5 * 60_000
const HALF_RATE_FOR = 10 * 60_000

// The site's pace at `now`, `throttledAt` the last throttle's time.
type Pace =
  | { readonly _tag: "stopped"; readonly until: number }
  | { readonly _tag: "half" }
  | { readonly _tag: "full" }
const paceAt = Effect.fnUntraced(function* (
  throttledAt: number | undefined,
  now: number
) {
  if (throttledAt === undefined) return { _tag: "full" } satisfies Pace
  if (now < throttledAt + STOPPED_FOR)
    return { _tag: "stopped", until: throttledAt + STOPPED_FOR } satisfies Pace
  if (now < throttledAt + STOPPED_FOR + HALF_RATE_FOR)
    return { _tag: "half" } satisfies Pace
  return { _tag: "full" } satisfies Pace
})

// A 429, or Cloudflare's challenge: its header, or an HTML page where the
// API answers JSON.
const isThrottle = Effect.fnUntraced(function* (answer: Answer) {
  return (
    answer.status === 429 ||
    answer.challenge === true ||
    /^\s*</.test(answer.body)
  )
})

// Decision: 3 calls a second per site; a throttle stops the site 5 minutes
// (apps/extension/docs/adr/0011-the-pacer-spaces-calls-and-backs-off-on-a-throttle.md)
const IN_FLIGHT: Readonly<Record<Feed, number>> = {
  Stockbit: Number.POSITIVE_INFINITY,
  Ajaib: 1,
}

export const makePacer = Effect.fnUntraced(function* (options: {
  readonly feed: Feed
  readonly tab: AnsweringTab
  // A throttle stopped the site until `until` (epoch ms), for the options
  // page.
  readonly throttled?: (until: number) => Effect.Effect<void>
  // The `until` a throttle stored before the service worker restarted: the
  // site stays stopped until then, and at half rate after it.
  readonly stoppedUntil?: number
}) {
  const maxInFlight = IN_FLIGHT[options.feed]
  // A call waiting for its turn, whether the dispatcher started it, and
  // whether its fetch holds the slot.
  interface Turn {
    readonly start: Deferred.Deferred<void>
    started: boolean
    handedOff: boolean
  }
  const waiting: Record<Priority, Array<Turn>> = { backfill: [], walk: [] }
  let inFlight = 0
  let nextStart = 0
  let throttledAt =
    options.stoppedUntil === undefined
      ? undefined
      : options.stoppedUntil - STOPPED_FOR
  // Wakes the dispatcher: a call arrived or one ended.
  const wakes = yield* Queue.sliding<void>(1)
  const wake = Queue.offer(wakes, undefined)
  const free = Effect.suspend(() => {
    inFlight--
    return wake
  })

  const noteThrottle = Effect.fnUntraced(function* (request: TabRequest) {
    const answer = yield* options.tab.awaitAnswer(request)
    if (Option.isSome(answer) && (yield* isThrottle(answer.value))) {
      throttledAt = yield* Clock.currentTimeMillis
      yield* Effect.logWarning(
        `${options.feed} throttled its REST calls: stopping for 5 minutes`
      )
      if (options.throttled !== undefined)
        yield* options.throttled(throttledAt + STOPPED_FOR)
    }
    return answer
  })

  // One paced REST call: it waits for its turn, then runs on the tab. An
  // interrupted call leaves the queue, or frees its slot if it started.
  // Decision: 3 calls a second per site; a throttle stops the site 5 minutes
  // (apps/extension/docs/adr/0011-the-pacer-spaces-calls-and-backs-off-on-a-throttle.md)
  const paced = Effect.fnUntraced(function* (
    priority: Priority,
    request: TabRequest
  ) {
    const turn: Turn = {
      start: yield* Deferred.make<void>(),
      started: false,
      handedOff: false,
    }
    const fetch = yield* Effect.ensuring(
      Effect.gen(function* () {
        waiting[priority].push(turn)
        yield* wake
        yield* Deferred.await(turn.start)
        return yield* Effect.uninterruptible(
          Effect.tap(
            Effect.forkDetach(Effect.ensuring(noteThrottle(request), free), {
              startImmediately: true,
            }),
            () =>
              Effect.sync(() => {
                turn.handedOff = true
              })
          )
        )
      }),
      Effect.suspend(() => {
        if (turn.handedOff) return Effect.void
        if (turn.started) return free
        const at = waiting[priority].indexOf(turn)
        if (at !== -1) waiting[priority].splice(at, 1)
        return wake
      })
    )
    return Option.flatten(
      yield* Effect.timeoutOption(Fiber.join(fetch), REQUEST_TIMEOUT)
    )
  })

  const tab = (priority: Priority): PacedTab =>
    ({
      // A REST call on the broker's API is paced, the PIN check's post too. A
      // cookie or the page's token is read in the tab and isn't.
      request: (request) =>
        request._tag === "fetch" ||
        request._tag === "page-fetch" ||
        request._tag === "page-post"
          ? paced(priority, request)
          : options.tab.request(request),
    }) as PacedTab

  // Starts the next waiting call once the site's pace allows one.
  const dispatch = Effect.gen(function* () {
    const queue = waiting.backfill.length > 0 ? waiting.backfill : waiting.walk
    if (queue.length === 0 || inFlight >= maxInFlight) {
      yield* Queue.take(wakes)
      return
    }
    const now = yield* Clock.currentTimeMillis
    const pace = yield* paceAt(throttledAt, now)
    const ready = pace._tag === "stopped" ? pace.until : nextStart
    if (now < ready) {
      yield* Effect.sleep(ready - now)
      return
    }
    // Backfill's first: the queue is chosen again after any wait above.
    const turn = queue.shift()
    if (turn === undefined) return
    turn.started = true
    inFlight++
    nextStart = now + (pace._tag === "half" ? HALF_SPACING : FULL_SPACING)
    yield* Deferred.succeed(turn.start, undefined)
  })
  const run = Effect.forever(dispatch)

  return { tab, run }
})
