import { Effect, Stream } from "effect"

import type { DayStateCode } from "./day-state-code.ts"
import { FrameScheduler } from "./frame-scheduler.ts"

// One stock code's (or index's) new Day state, as a source emits it.
export type DayStateUpdate<A> = {
  readonly code: DayStateCode
  readonly dayState: A
}

export type DayStateSnapshot<A> = ReadonlyMap<DayStateCode, A>

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
  (code: DayStateCode) =>
  <A>(snapshot: DayStateSnapshot<A>): A | undefined =>
    snapshot.get(code)

export const makeDayStateStore = Effect.fnUntraced(function* <A, R>(options: {
  readonly source: Stream.Stream<DayStateUpdate<A>, never, R>
  // The route loader's Day state: the server snapshot, and the client's
  // snapshot until the first update.
  readonly initial: DayStateSnapshot<A>
}) {
  const context = yield* Effect.context<FrameScheduler | R>()
  const { nextFrame } = yield* FrameScheduler
  const run = Effect.runCallbackWith(context)

  const listeners = new Set<() => void>()
  let snapshot = options.initial
  let frameScheduled = false
  let stop: (() => void) | undefined

  const notify = Effect.sync(() => {
    for (const listener of listeners) listener()
  })

  const frame = Effect.ensuring(
    nextFrame,
    Effect.sync(() => {
      frameScheduled = false
    })
  ).pipe(Effect.andThen(notify))

  // The snapshot changes as each update arrives; only notifying waits for the
  // frame. A new Map per update, so useSyncExternalStore sees the change.
  const apply = ({ code, dayState }: DayStateUpdate<A>) =>
    Effect.suspend(() => {
      snapshot = new Map(snapshot).set(code, dayState)
      if (frameScheduled) return Effect.void
      frameScheduled = true
      // A child of the source fiber, so stopping the source cancels the frame.
      return Effect.asVoid(Effect.forkChild(frame))
    })

  const feed = Stream.runForEach(options.source, apply)

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
