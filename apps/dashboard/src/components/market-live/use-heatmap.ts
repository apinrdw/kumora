import { clientRuntime, fetchRecordedHeatmap } from "@workspace/client"
import { INDEX_CODES, type StockCode, type WibDate } from "@workspace/relay"
import { Effect, Fiber, Option, Predicate } from "effect"
import { useEffect, useMemo } from "react"

import { makeHeatmapStore } from "./heatmap-store"
import { signInAgain } from "./sign-in-again"

// The selected code's heatmap store for the recorded `day`, or `today` live,
// seeded once by its heatmap GET: a recorded day's whole, a live day's up to
// the join it names, the page feeding the store its socket's messages from
// then on. An index has no book, so nothing is asked. A 401 sends the
// visitor to sign in.
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
    const fiber = clientRuntime.runFork(
      fetchRecordedHeatmap(date, code).pipe(
        Effect.tap((answer) =>
          Effect.sync(() => {
            if (Option.isSome(answer)) store.seed(answer.value, live)
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
    return () => void clientRuntime.runFork(Fiber.interrupt(fiber))
  }, [store, date, code, live])
  return store
}
