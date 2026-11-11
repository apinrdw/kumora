import type { DayState, StockCode, ViewerDown } from "@workspace/relay"
import { Effect } from "effect"
import { useSyncExternalStore } from "react"

export interface DayStateStore {
  readonly state: (code: StockCode) => DayState | undefined
  // Whether any code's figures are Ajaib's fallback.
  readonly fallback: () => boolean
  readonly apply: (message: ViewerDown) => void
  // Every code's state at once: a recorded day's rows at the cursor.
  readonly replace: (states: ReadonlyArray<DayState>) => void
  // `listener` hears every change of `code`'s state, or of any code's when
  // `code` is undefined.
  readonly subscribe: (
    code: StockCode | undefined,
    listener: () => void
  ) => () => void
}

// The Day state of each code the page watches, from the viewer socket,
// outside React: a watchlist row re-renders only when its own code changes. A
// snapshot replaces every code's; a delta's states replace theirs.
export const makeDayStateStore = () =>
  Effect.sync((): DayStateStore => {
    let states = new Map<StockCode, DayState>()
    const listeners = new Map<StockCode | undefined, Set<() => void>>()
    const emit = (codes: Iterable<StockCode>) => {
      for (const code of codes)
        for (const listener of listeners.get(code) ?? []) listener()
      for (const listener of listeners.get(undefined) ?? []) listener()
    }
    const replace = (arriving: ReadonlyArray<DayState>) => {
      const before = [...states.keys()]
      states = new Map(arriving.map((state) => [state.code, state]))
      emit(new Set([...before, ...states.keys()]))
    }
    return {
      state: (code) => states.get(code),
      fallback: () =>
        [...states.values()].some((state) => state.provenance === "Ajaib"),
      apply: (message) => {
        const arriving = message.dayStates ?? []
        if (message._tag === "Snapshot") return replace(arriving)
        if (arriving.length === 0) return
        for (const state of arriving) states.set(state.code, state)
        emit(arriving.map((state) => state.code))
      },
      replace,
      subscribe: (code, listener) => {
        const held = listeners.get(code) ?? new Set()
        listeners.set(code, held)
        held.add(listener)
        return () => void held.delete(listener)
      },
    }
  })

// One code's Day state; undefined while it has no figures yet.
export function useDayState(store: DayStateStore, code: StockCode) {
  return useSyncExternalStore(
    (listener) => store.subscribe(code, listener),
    () => store.state(code),
    () => undefined
  )
}

// Whether the watchlist's figures are Ajaib's fallback.
export function useDayStateFallback(store: DayStateStore) {
  return useSyncExternalStore(
    (listener) => store.subscribe(undefined, listener),
    store.fallback,
    () => false
  )
}
