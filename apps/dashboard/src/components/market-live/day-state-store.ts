import {
  makeDayStateStore as makeKeyedStore,
  selectDayState,
  type DayStateSnapshot,
  type DayStateStore as KeyedStore,
  type DayStateUpdate,
} from "@workspace/client"
import type { DayState, StockCode, ViewerDown } from "@workspace/relay"
import { Effect, Queue, Stream } from "effect"
import { useSyncExternalStore } from "react"

// A code's Day state, or undefined once a snapshot or the cursor dropped it.
export type HeldDayState = DayState | undefined

// The Day state of each code the page watches, in @workspace/client's keyed
// store: a watchlist row re-renders only when its own code changes, at most
// once a frame. Its source is the page's own changes, queued: the viewer
// socket's messages (`apply`) and a recorded day's rows at the cursor
// (`replace`). The queue keeps what arrives before the first row subscribes,
// and nothing drains it during SSR.
export interface DayStateStore extends KeyedStore<HeldDayState> {
  // A snapshot replaces every code's state; a delta's states replace theirs.
  readonly apply: (message: ViewerDown) => void
  // Every code's state at once: a recorded day's rows at the cursor.
  readonly replace: (states: ReadonlyArray<DayState>) => void
}

const updateOf = (state: DayState): DayStateUpdate<HeldDayState> => ({
  code: state.code,
  dayState: state,
})

// `initial` is the route loader's Day state: the server snapshot.
export const makeDayStateStore = Effect.fnUntraced(function* (
  initial: ReadonlyArray<DayState> = []
) {
  const changes = yield* Queue.unbounded<DayStateUpdate<HeldDayState>>()
  const store = yield* makeKeyedStore({
    source: Stream.fromQueue(changes),
    initial: new Map(initial.map((state) => [state.code, state])),
  })
  // The codes that hold a Day state once every queued change has applied, so
  // a replacement knows which codes to drop.
  let held = new Set(initial.map((state) => state.code))
  const offer = (updates: ReadonlyArray<DayStateUpdate<HeldDayState>>) =>
    void Queue.offerAllUnsafe(changes, updates)
  const replace = (states: ReadonlyArray<DayState>) => {
    const arriving = new Set(states.map((state) => state.code))
    const dropped = [...held].filter((code) => !arriving.has(code))
    held = arriving
    offer([
      ...states.map(updateOf),
      ...dropped.map((code) => ({ code, dayState: undefined })),
    ])
  }
  const marketLive: DayStateStore = {
    ...store,
    apply: (message) => {
      const arriving = message.dayStates ?? []
      if (message._tag === "Snapshot") return replace(arriving)
      for (const state of arriving) held.add(state.code)
      offer(arriving.map(updateOf))
    },
    replace,
  }
  return marketLive
})

// Whether any code's figures are Ajaib's fallback.
const isFallback = Effect.fnUntraced(function* (
  snapshot: DayStateSnapshot<HeldDayState>
) {
  for (const state of snapshot.values())
    if (state?.provenance === "Ajaib") return true
  return false
})

// One code's Day state; undefined while it has no figures yet.
export function useDayState(store: DayStateStore, code: StockCode) {
  return useSyncExternalStore(
    store.subscribe,
    () => Effect.runSync(selectDayState(store.getSnapshot(), code)),
    () => Effect.runSync(selectDayState(store.getServerSnapshot(), code))
  )
}

// Whether the watchlist's figures are Ajaib's fallback.
export function useDayStateFallback(store: DayStateStore) {
  return useSyncExternalStore(
    store.subscribe,
    () => Effect.runSync(isFallback(store.getSnapshot())),
    () => Effect.runSync(isFallback(store.getServerSnapshot()))
  )
}
