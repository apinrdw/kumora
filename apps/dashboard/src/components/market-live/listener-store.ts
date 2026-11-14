// One value outside React that components read with useSyncExternalStore:
// chart 2's header and hover ladder, which its canvas sets on each hover.
import { Effect } from "effect"

export interface ListenerStore<T> {
  // Tells the listeners, unless `next` is the value already held.
  readonly set: (next: T) => void
  readonly get: () => T
  readonly subscribe: (listener: () => void) => () => void
}

export const makeListenerStore = <T>(initial: T) =>
  Effect.sync((): ListenerStore<T> => {
    let value = initial
    const listeners = new Set<() => void>()
    return {
      set: (next) => {
        if (Object.is(next, value)) return
        value = next
        for (const listener of listeners) listener()
      },
      get: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
