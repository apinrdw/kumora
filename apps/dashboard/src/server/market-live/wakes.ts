// The trading day's alarm duties and when each is next due.
import { DateTime, Effect } from "effect"

import { Fact, type DayStore } from "./day-store.ts"

// Decision: each alarm duty's deadline is a fact in the day's store, written
// whenever it is set, so a start restores it and never moves it. The alarm
// is armed for the earliest; it runs only the due duties, and each checks
// its own precondition before it acts. See spec apinrdw/kumora#437, "When it
// runs".
// A due move runs after a due build, which it waits for.
export const WAKES = ["seal", "build", "move"] as const
export type Wake = (typeof WAKES)[number]

const FACT: Record<Wake, string> = {
  seal: Fact.sealWake,
  build: Fact.buildWake,
  move: Fact.moveWake,
}

export const makeWakes = Effect.fnUntraced(function* (
  store: Pick<DayStore, "fact" | "setFact">,
  // Wakes the object at `at`, unless it is woken sooner already.
  arm: (at: DateTime.Utc) => Effect.Effect<void>
) {
  const deadlines = new Map<Wake, DateTime.Utc>()
  for (const wake of WAKES) {
    const stored = yield* store.fact(FACT[wake])
    if (stored !== undefined)
      deadlines.set(wake, DateTime.makeUnsafe(Number(stored)))
  }

  const write = Effect.fnUntraced(function* (
    wake: Wake,
    at: DateTime.Utc | undefined
  ) {
    yield* store.setFact(
      FACT[wake],
      at === undefined ? undefined : String(DateTime.toEpochMillis(at))
    )
    if (at === undefined) deadlines.delete(wake)
    else deadlines.set(wake, at)
  })

  return {
    deadline: (wake: Wake) => Effect.sync(() => deadlines.get(wake)),
    due: (wake: Wake, now: DateTime.Utc) =>
      Effect.sync(() => {
        const at = deadlines.get(wake)
        return at !== undefined && !DateTime.isLessThan(now, at)
      }),
    // A wake's next deadline, none once its duty is done.
    set: (wake: Wake, at: DateTime.Utc | undefined) =>
      write(wake, at).pipe(
        Effect.andThen(at === undefined ? Effect.void : arm(at))
      ),
    // A wake with no deadline stored, as a day stored before deadlines were
    // leaves it, takes `first` from the day's facts, stored at once.
    restore: (wake: Wake, first: Effect.Effect<DateTime.Utc | undefined>) =>
      deadlines.has(wake)
        ? Effect.void
        : Effect.flatMap(first, (at) =>
            at === undefined ? Effect.void : write(wake, at)
          ),
    // Arms the alarm for the earliest deadline.
    armEarliest: Effect.suspend(() => {
      let earliest: DateTime.Utc | undefined
      for (const at of deadlines.values())
        if (earliest === undefined || DateTime.isLessThan(at, earliest))
          earliest = at
      return earliest === undefined ? Effect.void : arm(earliest)
    }),
  }
})
