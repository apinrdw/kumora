import { Effect } from "effect"
import { useEffect, useRef } from "react"

const LOCK = "kumora:book-alerts"

// Holds the lock until `signal` aborts.
const untilAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) =>
    signal.addEventListener("abort", () => resume(Effect.void), { once: true })
  )

// Decision: one live page per browser tells alerts: the one last brought to
// the front holds the Web Lock `kumora:book-alerts` and records, chimes and
// toasts (notifies once hidden); the others queue for it, tell nothing and
// keep their gates in step. Without Web Locks every page tells. See
// apinrdw/kumora#526.
/** Whether this page holds the browser's alert lock, read when an event arrives. */
export function useAlertOwner() {
  const owns = useRef(false)
  useEffect(() => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks
    if (locks === undefined) {
      owns.current = true
      return () => {
        owns.current = false
      }
    }
    let release: (() => void) | undefined
    const take = (steal: boolean) => {
      release?.()
      const controller = new AbortController()
      const mine = () => {
        owns.current = false
        controller.abort()
      }
      release = mine
      locks
        .request(
          LOCK,
          steal ? { steal: true } : { signal: controller.signal },
          () => {
            owns.current = true
            return Effect.runPromise(untilAborted(controller.signal))
          }
        )
        // Stolen by a page brought to the front: queue again behind it.
        .catch(() => {
          if (release !== mine) return
          owns.current = false
          take(false)
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && !owns.current) take(true)
    }
    take(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      const last = release
      release = undefined
      last?.()
    }
  }, [])
  return owns
}
