import { Effect, Fiber, Scheduler } from "effect"

// Runs `first` as a fiber that yields once, at its `at`-th operation, and
// `second` while it is suspended, as an overlapping callback does when the
// default scheduler yields a fiber at its 2048th operation. By default
// `second` runs until it suspends and `first` resumes in its turn, so a
// `second` that waits on `first` (a handler waiting for the permit `first`
// holds) lets it finish. With `holdFirst`, `first` stays suspended until
// `second` has run whole, its own suspensions included (a clock adjust that
// wakes a timer). Whether `first` reached that operation.
const splitAt = <A, E, R, B, E2, R2>(
  at: number,
  first: Effect.Effect<A, E, R>,
  second: Effect.Effect<B, E2, R2>,
  holdFirst: boolean
) =>
  Effect.gen(function* () {
    const parent = yield* Scheduler.Scheduler
    let count = 0
    let yielded = false
    let held: Array<() => void> | undefined = holdFirst ? [] : undefined
    const scheduler: Scheduler.Scheduler = {
      executionMode: parent.executionMode,
      shouldYield: () => {
        if (++count !== at) return false
        yielded = true
        return true
      },
      makeDispatcher: () => {
        const dispatcher = parent.makeDispatcher()
        return {
          scheduleTask: (task, priority) => {
            if (held === undefined) dispatcher.scheduleTask(task, priority)
            else held.push(task)
          },
          flush: () => dispatcher.flush(),
        }
      },
    }
    const fiber = yield* Effect.forkChild(
      Effect.provideService(first, Scheduler.Scheduler, scheduler),
      { startImmediately: true }
    )
    yield* second
    const resume = held ?? []
    held = undefined
    for (const task of resume) task()
    yield* Fiber.join(fiber)
    return yielded
  })

const SPLIT_LIMIT = 100_000

// Runs `first` and `second` from a fresh `setup` once per operation of
// `first`, with `first` yielding at that operation and `second` running
// during the yield, and runs `check` on each outcome: every point the
// scheduler could split `first` at is tried, so a read and the write that
// depends on it are split whatever lies between them. Returns how many
// operations `first` took.
export const everySplit = <S, E, R>(options: {
  readonly setup: Effect.Effect<S, E, R>
  readonly first: (state: S) => Effect.Effect<unknown, E, R>
  readonly second: (state: S) => Effect.Effect<unknown, E, R>
  readonly check: (state: S, at: number) => Effect.Effect<void, E, R>
  readonly holdFirst?: boolean
}) =>
  Effect.gen(function* () {
    for (let at = 1; at <= SPLIT_LIMIT; at++) {
      const state = yield* options.setup
      const yielded = yield* splitAt(
        at,
        options.first(state),
        options.second(state),
        options.holdFirst ?? false
      )
      if (!yielded) return at - 1
      yield* options.check(state, at)
    }
    return yield* Effect.die(
      new Error(`first still runs after ${SPLIT_LIMIT} operations`)
    )
  })
