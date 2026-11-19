// The reconcile cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. It returns a Promise for the reason the
// shareholding archive's (../shareholding/cron.ts) does: the day strip from
// the index Durable Object, each poke to its day's trading-day object. After
// the broker totals, it asks the recent hot days to move to R2, then a few
// of the older ones (../market-live/cold-moves.ts).
import { decodeDayStrip, type WibDate } from "@workspace/relay"
import { WorkerEnv, runServerEffectResult } from "@workspace/server"
import { Effect, Schema } from "effect"

import { askOlderMoves, askDueMoves } from "../market-live/cold-moves.ts"
import { DAY_INDEX, DayIndexPath, ObjectPath } from "../market-live/routes.ts"
import { brokerTotalsDbD1 } from "./db.ts"
import { reconcileBrokerTotals } from "./reconcile.ts"

// A trading-day object answered a poke with neither 202 nor 204.
class PokeRefused extends Schema.TaggedError<PokeRefused>()("PokeRefused", {
  status: Schema.Int,
}) {}

const stripDays = Effect.gen(function* () {
  const index = (yield* WorkerEnv).MARKET_LIVE_INDEX.getByName(DAY_INDEX)
  const response = yield* Effect.promise((): Promise<Response> =>
    index.fetch(new URL(DayIndexPath, "https://day-index.invalid"))
  )
  const strip = yield* decodeDayStrip(
    yield* Effect.promise(() => response.text())
  )
  return strip.days
})

// POSTs `path` to `day`'s object: true on 202, false on 204.
const poke = (path: string) =>
  Effect.fnUntraced(function* (day: WibDate) {
    const object = (yield* WorkerEnv).TRADING_DAY.getByName(day)
    const response = yield* Effect.tryPromise((): Promise<Response> =>
      object.fetch(new URL(path, "https://trading-day.invalid"), {
        method: "POST",
      })
    )
    if (response.status === 202) return true
    if (response.status === 204) return false
    return yield* new PokeRefused({ status: response.status })
  })

// The moves are asked whether or not the reconcile failed.
export const runReconcileCron = () =>
  runServerEffectResult(
    Effect.gen(function* () {
      const reconciled = yield* Effect.exit(
        reconcileBrokerTotals(
          Effect.map(stripDays, (days) => days.map((row) => row.day)),
          poke(ObjectPath.brokerTotals)
        ).pipe(Effect.provide(brokerTotalsDbD1))
      )
      const listed = yield* Effect.cached(stripDays)
      yield* askDueMoves(listed, poke(ObjectPath.move))
      yield* askOlderMoves(listed, poke(ObjectPath.move))
      return yield* reconciled
    })
  )
