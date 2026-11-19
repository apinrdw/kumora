// The reconcile cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. It returns a Promise for the reason the
// shareholding archive's (../shareholding/cron.ts) does: the day strip from
// the index Durable Object, each poke to its day's trading-day object. After
// the broker totals, it asks the recent hot days to move to R2, then a few
// of the older ones (../market-live/cold-moves.ts).
import { runServerEffectResult } from "@workspace/server"
import { Effect } from "effect"

import { askOlderMoves, askDueMoves } from "../market-live/cold-moves.ts"
import { pokeDay, stripDays } from "../market-live/day-calls.ts"
import { ObjectPath } from "../market-live/routes.ts"
import { brokerTotalsDbD1 } from "./db.ts"
import { reconcileBrokerTotals } from "./reconcile.ts"

// The moves are asked whether or not the reconcile failed.
export const runReconcileCron = () =>
  runServerEffectResult(
    Effect.gen(function* () {
      const reconciled = yield* Effect.exit(
        reconcileBrokerTotals(
          Effect.map(stripDays, (days) => days.map((row) => row.day)),
          pokeDay(ObjectPath.brokerTotals)
        ).pipe(Effect.provide(brokerTotalsDbD1))
      )
      const listed = yield* Effect.cached(stripDays)
      yield* askDueMoves(listed, pokeDay(ObjectPath.move))
      yield* askOlderMoves(listed, pokeDay(ObjectPath.move))
      return yield* reconciled
    })
  )
