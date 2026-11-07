import { Effect, Stream } from "effect"

import { FrameScheduler } from "./frame-scheduler.ts"

// One stock code's (or index's) new Day state, as a source emits it.
export type DayStateUpdate<A> = {
  readonly code: string
  readonly dayState: A
}

export type DayStateSnapshot<A> = ReadonlyMap<string, A>

// The shape useSyncExternalStore takes. React calls these, so they are plain
// functions.
export type DayStateStore<A> = {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => DayStateSnapshot<A>
  readonly getServerSnapshot: () => DayStateSnapshot<A>
}

// The per-row selector. A row's value keeps its identity until its own stock
// code updates, so Object.is skips every other row.
export const selectDayState =
  (code: string) =>
  <A>(snapshot: DayStateSnapshot<A>): A | undefined =>
    snapshot.get(code)

export const makeDayStateStore = Effect.fnUntraced(function* <A, R>(options: {
  readonly source: Stream.Stream<DayStateUpdate<A>, never, R>
  // The route loader's Day state: the server snapshot, and the client's
  // snapshot until the first frame.
  readonly initial: DayStateSnapshot<A>
}) {
  const context = yield* Effect.context<FrameScheduler | R>()
  const { nextFrame } = yield* FrameScheduler
  const run = Effect.runCallbackWith(context)

  const listeners = new Set<() => void>()
  let snapshot = options.initial
  // Updates since the last frame. Defined while a frame is scheduled.
  let pending: Map<string, A> | undefined
  let stop: (() => void) | undefined

  const fold = Effect.sync(() => {
    if (pending === undefined) return false
    const next = new Map(snapshot)
    for (const [code, dayState] of pending) next.set(code, dayState)
    snapshot = next
    pending = undefined
    return true
  })

  const publish = Effect.andThen(fold, (changed) =>
    Effect.sync(() => {
      if (changed) for (const listener of listeners) listener()
    })
  )

  const apply = ({ code, dayState }: DayStateUpdate<A>) =>
    Effect.suspend(() => {
      if (pending !== undefined) {
        pending.set(code, dayState)
        return Effect.void
      }
      pending = new Map([[code, dayState]])
      // A child of the source fiber, so stopping the source cancels the frame.
      return Effect.asVoid(Effect.forkChild(Effect.andThen(nextFrame, publish)))
    })

  // Folds in updates whose frame was cancelled, so a later subscriber's first
  // snapshot holds them.
  const feed = Effect.ensuring(Stream.runForEach(options.source, apply), fold)

  const subscribe = (listener: () => void) => {
    // A fresh entry per subscription, so subscribing one listener twice counts twice.
    const entry = () => listener()
    listeners.add(entry)
    if (stop === undefined) stop = run(feed)
    return () => {
      listeners.delete(entry)
      if (listeners.size === 0 && stop !== undefined) {
        stop()
        stop = undefined
      }
    }
  }

  const store: DayStateStore<A> = {
    subscribe,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => options.initial,
  }
  return store
})
