import { Effect } from "effect"
import { useEffect, useRef } from "react"

const LOCK = "kumora:book-alerts"

// Holds the lock until `signal` aborts.
const untilAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) =>
    signal.addEventListener("abort", () => resume(Effect.void), { once: true })
  )

// Decision: one live page per browser tells alerts: the one the user last
// brought to the front holds the Web Lock `kumora:book-alerts`, stealing it
// when its tab becomes visible, and records each alert in the shared
// history, chimes, and shows the toast, or the notification once its tab is
// hidden. The other live pages queue for the lock and tell nothing; they
// still run the gate on the same events, so a page that takes over keeps the
// cooldowns. Without Web Locks every page tells, as one tab alone does. See
// spec apinrdw/kumora#517, "Alerts".
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
