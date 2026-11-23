import { Effect } from "effect"
import { useEffect, useRef } from "react"

const LOCK = "kumora:book-alerts"

// Holds the lock until `signal` aborts, or not at all when it already has.
const untilAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    signal.addEventListener("abort", () => resume(Effect.void), { once: true })
  })

// The live page last brought to the front (shown or focused)
// holds the Web Lock `kumora:book-alerts` and tells; others queue, a
// recorded day's page never asks, and a grant to a replaced or unmounted
// request lets go at once. Without Web Locks every live page tells. See
// apinrdw/kumora#526.
/** Whether this page holds the browser's alert lock, read when an event arrives. */
export function useAlertOwner(live: boolean) {
  const owns = useRef(false)
  useEffect(() => {
    if (!live) return
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks
    if (locks === undefined) {
      owns.current = true
      return () => {
        owns.current = false
      }
    }
    let current: AbortController | undefined
    const drop = () => {
      owns.current = false
      current?.abort()
      current = undefined
    }
    const take = (steal: boolean) => {
      drop()
      const controller = new AbortController()
      current = controller
      locks
        .request(
          LOCK,
          steal ? { steal: true } : { signal: controller.signal },
          () => {
            if (current === controller) owns.current = true
            return Effect.runPromise(untilAborted(controller.signal))
          }
        )
        // Stolen by a page brought to the front: queue again behind it.
        .catch(() => {
          if (current === controller) take(false)
        })
    }
    // Two windows can both stay visible, so focus says which came forward.
    const onFront = () => {
      if (document.visibilityState === "visible" && !owns.current) take(true)
    }
    take(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onFront)
    window.addEventListener("focus", onFront)
    return () => {
      document.removeEventListener("visibilitychange", onFront)
      window.removeEventListener("focus", onFront)
      drop()
    }
  }, [live])
  return owns
}
