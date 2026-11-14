import { clientRuntime, fetchRecordedHeatmap } from "@workspace/client"
import {
  INDEX_CODES,
  type RecordedHeatmap,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Effect, Fiber, Option, Predicate } from "effect"
import { useEffect, useMemo } from "react"

import { makeHeatmapStore } from "./heatmap-store"
import { signInAgain } from "./sign-in-again"

// The selected code's heatmap store for the recorded `day`, or `today` live.
// A recorded day's is seeded once, whole, by its heatmap GET. Live, the GET
// is asked again each time the store asks (each snapshot of the code, a
// reconnect's included), the page feeding the store its socket's messages.
// An index has no book, so nothing is asked. A 401 sends the visitor to
// sign in.
export function useHeatmap(
  code: StockCode,
  day: WibDate | undefined,
  today: WibDate
) {
  const date = day ?? today
  const live = day === undefined
  // The page mounts afresh for each day shown, so a code's store is one
  // day's.
  const store = useMemo(() => Effect.runSync(makeHeatmapStore(code)), [code])
  useEffect(() => {
    if (INDEX_CODES.includes(code)) return
    const fibers: Array<Fiber.Fiber<unknown>> = []
    const load = (seed: (answer: RecordedHeatmap) => void) =>
      fibers.push(
        clientRuntime.runFork(
          fetchRecordedHeatmap(date, code).pipe(
            Effect.tap((answer) =>
              Effect.sync(() => {
                if (Option.isSome(answer)) seed(answer.value)
              })
            ),
            Effect.catchIf(
              (error) => Predicate.isTagged(error, "SignInRequired"),
              () => signInAgain
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Book heatmap not loaded", cause)
            )
          )
        )
      )
    let asked: number | undefined
    const askIfAwaiting = () => {
      const asking = store.awaiting()
      if (asking === undefined || asking === asked) return
      asked = asking
      load((answer) => store.answer(asking, answer))
    }
    let stop: (() => void) | undefined
    if (live) {
      stop = store.subscribe(askIfAwaiting)
      askIfAwaiting()
    } else load(store.seed)
    return () => {
      stop?.()
      for (const fiber of fibers) clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [store, date, code, live])
  return store
}
