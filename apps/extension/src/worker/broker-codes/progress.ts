// The broker codes progress the options page shows (spec apinrdw/kumora#244,
// "The extension: options page and badge"): what the run queue reports,
// with the walk's own trades and pace, and Stockbit's signed-out wait over
// both.
import { Clock, Effect, Option } from "effect"

import type { BrokerCodesProgress } from "./run-queue.ts"

// Decision: a walk's trades are written at most once a second; a walk
// fetching 3 pages a second would otherwise write session storage, and
// wake the page and the badge, on every page.
const TRADES_EVERY = 1_000

export const makeProgress = Effect.fnUntraced(function* (
  save: (progress: BrokerCodesProgress) => Effect.Effect<void>
) {
  let reported: BrokerCodesProgress = { state: "idle" }
  let signedOut = false
  // The walk's first trades and when they came, which its pace counts from,
  // and when its trades were last written.
  let first = Option.none<{ readonly at: number; readonly fetched: number }>()
  let written = Number.NEGATIVE_INFINITY

  const show = Effect.suspend(() =>
    save(signedOut ? { state: "paused", cause: "signed-out" } : reported)
  )

  return {
    // The run queue's report: a new walk, a pause or idle.
    report: (progress: BrokerCodesProgress) =>
      Effect.suspend(() => {
        reported = progress
        first = Option.none()
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
      const since = Option.getOrElse(first, () => ({ at: now, fetched }))
      first = Option.some(since)
      const seconds = (now - since.at) / 1_000
      reported = {
        ...reported,
        trades: {
          fetched,
          of: Option.getOrNull(of),
          perSecond:
            seconds >= 1
              ? Math.round((fetched - since.fetched) / seconds)
              : null,
        },
      }
      if (now - written < TRADES_EVERY) return
      written = now
      yield* show
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
