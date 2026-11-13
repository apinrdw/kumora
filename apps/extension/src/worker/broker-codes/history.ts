// The History walk (spec apinrdw/kumora#244, "The extension: the History
// walk"): once the newest closed day and the older days' gaps are done,
// Stockbit's walk of the days before the extension was installed, newest
// first, until Stockbit stops serving older days.
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { weekdayBefore } from "./hours.ts"
import type { BrokerCodesProgress, DayWalk, PauseCause } from "./run-queue.ts"

// Decision: 15 empty weekdays in a row end the History walk for good: no
// IDX holiday runs that long, so Stockbit no longer serves the days. New
// days come only from the daily run. See apinrdw/kumora#130.
const EMPTY_TO_END = 15

// Production's History walk position, kept across restarts (settings.ts).
export const HistoryPosition = Schema.Struct({
  // The oldest day the walk is done with.
  oldest: WibDate,
  // The empty weekdays in a row, down to `oldest`.
  empty: Schema.Int,
  ended: Schema.Boolean,
})
export type HistoryPosition = typeof HistoryPosition.Type

export interface HistoryStore {
  readonly load: Effect.Effect<Option.Option<HistoryPosition>>
  readonly save: (position: HistoryPosition) => Effect.Effect<void>
}

// The extra target's: the oldest History day it caught up.
export interface HistoryCatchUpStore {
  readonly load: Effect.Effect<Option.Option<WibDate>>
  readonly save: (oldest: WibDate) => Effect.Effect<void>
}

export const makeHistoryWalk = Effect.fnUntraced(function* (options: {
  // Production's walk of a day: Stockbit's gap walk, which answers a
  // complete day from its status alone, walks a day with nothing held
  // whole, and gives up a day with no rows without posting.
  readonly walk: DayWalk
  readonly store: HistoryStore
  // The extra target's catch-up of a day (extra-target.ts).
  readonly catchUp: DayWalk
  readonly catchUpStore: HistoryCatchUpStore
  readonly report: (progress: BrokerCodesProgress) => Effect.Effect<void>
}) {
  // Decision: a lost position starts again from the weekday before the
  // newest closed day. The gap walk answers each complete day from one
  // status GET, and asks Stockbit again about each empty one, so the walk
  // rebuilds the position and the empty count as it goes. See
  // apinrdw/kumora#244, "Position".
  const walk = Effect.fnUntraced(function* (newest: WibDate) {
    const kept = yield* options.store.load
    if (Option.isSome(kept) && kept.value.ended)
      return Option.none<PauseCause>()
    let empty = Option.match(kept, {
      onNone: () => 0,
      onSome: (position) => position.empty,
    })
    let day = yield* weekdayBefore(
      Option.match(kept, {
        onNone: () => newest,
        onSome: ({ oldest }) => oldest,
      })
    )
    while (true) {
      yield* options.report({
        state: "walking",
        walk: "history",
        day,
        feed: options.walk.feed,
      })
      const result = yield* options.walk.walk(day)
      if (result._tag === "stopped") return Option.some(result.cause)
      // Decision: a day the walk leaves incomplete stays so; it doesn't join
      // the incomplete-days list, since a day Stockbit walked whole has
      // nothing more for a gap walk to find. See apinrdw/kumora#252.
      empty =
        result._tag === "unserved" && result.reason === "no-rows"
          ? empty + 1
          : 0
      const ended = empty >= EMPTY_TO_END
      yield* options.store.save({ oldest: day, empty, ended })
      if (ended) return Option.none<PauseCause>()
      day = yield* weekdayBefore(day)
    }
  })

  // Decision: the extra target follows Production's History walk, never
  // past it: from the oldest day it caught up (at first the weekday before
  // the newest closed day) back to Production's oldest, each day from its
  // own status. Production's walk alone knows a day is untraded, and
  // asked nothing more of Stockbit. See apinrdw/kumora#244, "Targets".
  const catchUp = Effect.fnUntraced(function* (newest: WibDate) {
    const reached = yield* options.store.load
    if (Option.isNone(reached)) return
    const kept = yield* options.catchUpStore.load
    let day = yield* weekdayBefore(Option.getOrElse(kept, () => newest))
    while (day >= reached.value.oldest) {
      const result = yield* options.catchUp.walk(day)
      if (result._tag === "stopped") return
      yield* options.catchUpStore.save(day)
      day = yield* weekdayBefore(day)
    }
  })

  return { walk, catchUp }
})
