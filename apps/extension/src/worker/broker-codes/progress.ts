// The broker codes progress the options page shows (spec apinrdw/kumora#244,
// "The extension: options page and badge"): what the run queue reports,
// with the walk's own trades and pace, and Stockbit's signed-out wait over
// them.
import { Clock, Effect, Option } from "effect"

import type { BrokerCodesProgress, WalkPhase } from "./run-queue.ts"

// A walk's trades are written at most once a second; a walk
// fetching 3 pages a second would otherwise write session storage, and
// wake the page and the badge, on every page.
const TRADES_EVERY = 1_000

// A count's first report and when it came, which its pace counts from.
interface Since {
  readonly at: number
  readonly count: number
}

// The count's rise a second since its first report, once a second has
// passed.
const pace = (since: Since, now: number, count: number) => {
  const seconds = (now - since.at) / 1_000
  return seconds >= 1 ? (count - since.count) / seconds : null
}

export const makeProgress = Effect.fnUntraced(function* (
  save: (progress: BrokerCodesProgress) => Effect.Effect<void>
) {
  let reported: BrokerCodesProgress = { state: "idle" }
  let signedOut = false
  // The walk's first trades, and when its counts were last written.
  let firstTrades = Option.none<Since>()
  let written = Number.NEGATIVE_INFINITY

  const show = Effect.suspend(() =>
    save(signedOut ? { state: "paused", cause: "signed-out" } : reported)
  )

  // Writes the walk's counts as of `now`, unless they were written in the
  // second before it.
  const write = (now: number) =>
    Effect.suspend(() => {
      if (now - written < TRADES_EVERY) return Effect.void
      written = now
      return show
    })

  return {
    // The run queue's report: a new walk, a pause or idle.
    report: (progress: BrokerCodesProgress) =>
      Effect.suspend(() => {
        reported = progress
        firstTrades = Option.none()
        written = Number.NEGATIVE_INFINITY
        return show
      }),

    // The walk in progress has fetched `fetched` trades of the day's `of`.
    trades: Effect.fnUntraced(function* (
      fetched: number,
      of: Option.Option<number>
    ) {
      if (reported.state !== "walking") return
      const now = yield* Clock.currentTimeMillis
      const since = Option.getOrElse(firstTrades, () => ({
        at: now,
        count: fetched,
      }))
      firstTrades = Option.some(since)
      const perSecond = pace(since, now, fetched)
      reported = {
        ...reported,
        trades: {
          fetched,
          of: Option.getOrNull(of),
          perSecond: perSecond === null ? null : Math.round(perSecond),
        },
      }
      yield* write(now)
    }),

    // What the walk in progress is doing, written at once: a phase changes
    // a few times a walk.
    phase: (phase: WalkPhase) =>
      Effect.suspend(() => {
        if (reported.state !== "walking") return Effect.void
        reported = { ...reported, phase }
        return show
      }),

    // The Done Details walk has walked `done` of the day's `of` codes.
    codes: Effect.fnUntraced(function* (done: number, of: number) {
      if (reported.state !== "walking") return
      reported = { ...reported, stockCodes: { done, of } }
      yield* write(yield* Clock.currentTimeMillis)
    }),

    // Stockbit's walk waits on a signed-out tab, or stopped waiting.
    signedOut: (out: boolean) =>
      Effect.suspend(() => {
        if (signedOut === out) return Effect.void
        signedOut = out
        return show
      }),
  }
})
