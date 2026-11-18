import { Effect } from "effect"

// Who watches a value kept in localStorage, as `useSyncExternalStore`
// subscribes: this page's write runs `changed`, and another tab's write fires
// `storage`.
export const makeStorageListeners = Effect.sync(() => {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      window.addEventListener("storage", listener)
      return () => {
        listeners.delete(listener)
        window.removeEventListener("storage", listener)
      }
    },
    changed: Effect.sync(() => {
      for (const listener of listeners) listener()
    }),
  }
})
