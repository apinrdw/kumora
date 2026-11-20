// The broker codes progress the options page shows (spec apinrdw/kumora#244,
// "The extension: options page and badge"): what the run queue reports,
// with the walk's own trades and pace, the blocks of Ajaib's repair pass,
// and Stockbit's signed-out wait over them.
import { Clock, Effect, Option } from "effect"

import type { BrokerCodesProgress, WalkPhase } from "./run-queue.ts"

// Decision: a walk's trades are written at most once a second; a walk
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
  // The walk's first trades and its repair pass's first blocks, and when
  // either was last written.
  let firstTrades = Option.none<Since>()
  let firstRepair = Option.none<Since>()
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
        firstRepair = Option.none()
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

    // Ajaib's repair pass has walked `done` of its `of` blocks again. Its
    // pace is a fraction of a block a second, so it isn't rounded. The
    // pass's start is written at once: until then the page shows the first
    // pass's time left.
    repair: Effect.fnUntraced(function* (done: number, of: number) {
      if (reported.state !== "walking") return
      const now = yield* Clock.currentTimeMillis
      if (Option.isNone(firstRepair)) written = Number.NEGATIVE_INFINITY
      const since = Option.getOrElse(firstRepair, () => ({
        at: now,
        count: done,
      }))
      firstRepair = Option.some(since)
      reported = {
        ...reported,
        repair: { done, of, perSecond: pace(since, now, done) },
      }
      yield* write(now)
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
