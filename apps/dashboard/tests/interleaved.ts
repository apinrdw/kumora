import { Effect, Scheduler } from "effect"

// Runs `first` as a fiber that yields once, at its `at`-th operation, and
// `second` as a fiber that never yields: `second` runs whole while `first`
// is suspended, as an overlapping callback does when the default scheduler
// yields a fiber at its 2048th operation. Whether `first` reached that
// operation.
const splitAt = <A, E, R, B, E2, R2>(
  at: number,
  first: Effect.Effect<A, E, R>,
  second: Effect.Effect<B, E2, R2>
) =>
  Effect.gen(function* () {
    const parent = yield* Scheduler.Scheduler
    let count = 0
    let yielded = false
    const scheduler: Scheduler.Scheduler = {
      executionMode: parent.executionMode,
      makeDispatcher: () => parent.makeDispatcher(),
      shouldYield: () => {
        if (++count !== at) return false
        yielded = true
        return true
      },
    }
    yield* Effect.all(
      [Effect.provideService(first, Scheduler.Scheduler, scheduler), second],
      { concurrency: "unbounded" }
    )
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
}) =>
  Effect.gen(function* () {
    for (let at = 1; at <= SPLIT_LIMIT; at++) {
      const state = yield* options.setup
      const yielded = yield* splitAt(
        at,
        options.first(state),
        options.second(state)
      )
      if (!yielded) return at - 1
      yield* options.check(state, at)
    }
    return yield* Effect.die(
      new Error(`first still runs after ${SPLIT_LIMIT} operations`)
    )
  })
