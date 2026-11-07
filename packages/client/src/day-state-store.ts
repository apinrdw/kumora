import { Effect, Fiber, Stream } from "effect"

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

// The per-row selector, pure, so render may runSync it. A row's value keeps its
// identity until its own stock code updates, so Object.is skips every other row.
export const selectDayState = Effect.fnUntraced(function* <A>(
  snapshot: DayStateSnapshot<A>,
  code: DayStateCode
): Effect.fn.Return<A | undefined> {
  return snapshot.get(code)
})

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
  let stop: (() => void) | undefined

  const notify = Effect.sync(() => {
    for (const listener of listeners) listener()
  })

  // Each run of the source owns its frame state. A stopped run's interruption
  // can still be finishing when the next subscription starts the next run, so
  // a run that shared this state could cancel a frame the new run relies on.
  const runSource = Effect.suspend(() => {
    let frameScheduled = false
    let lastFrame: Fiber.Fiber<void> | undefined

    const frame = nextFrame.pipe(
      Effect.andThen(
        Effect.sync(() => {
          frameScheduled = false
        })
      ),
      Effect.andThen(notify)
    )

    // The snapshot changes as each update arrives; only notifying waits for
    // the frame. A new Map per update, so useSyncExternalStore sees the change.
    const apply = ({ code, dayState }: DayStateUpdate<A>) =>
      Effect.suspend(() => {
        snapshot = new Map(snapshot).set(code, dayState)
        if (frameScheduled) return Effect.void
        frameScheduled = true
        // A child of the source fiber, so stopping the source cancels the frame.
        return Effect.map(Effect.forkChild(frame), (fiber) => {
          lastFrame = fiber
        })
      })

    // A finite source waits for its last frame, so its final update notifies.
    return Stream.runForEach(options.source, apply).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          lastFrame === undefined ? Effect.void : Fiber.await(lastFrame)
        )
      ),
      Effect.asVoid
    )
  })

  const subscribe = (listener: () => void) => {
    // A fresh entry per subscription, so subscribing one listener twice counts twice.
    const entry = () => listener()
    listeners.add(entry)
    if (stop === undefined) stop = run(runSource)
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
