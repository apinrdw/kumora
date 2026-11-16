// The daily broker totals reconcile (spec apinrdw/kumora#437, "Dashboard:
// reconcile cron"): the day index's days against the broker totals DB's
// built days, each listed day that is unbuilt or built at an older build
// version poked to build on its trading day's alarm. ./cron.ts runs it on
// the Worker's bindings.
import type { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { BROKER_TOTALS_VERSION } from "../market-live/broker-totals.ts"
import { readBuiltDays } from "./db.ts"

// Decision: at most this many pokes a run, newest first, so a build version
// bump or a backlog re-derives history at about 20 days a day and never
// bursts D1's writes. See apinrdw/kumora#420.
const POKES_PER_RUN = 20

export const reconcileBrokerTotals = Effect.fnUntraced(function* <E, R>(
  // The day index's days.
  listed: Effect.Effect<ReadonlyArray<WibDate>, E, R>,
  // Asks one day's trading day to build.
  poke: (day: WibDate) => Effect.Effect<void, unknown, R>
) {
  const days = yield* listed
  const versions = new Map(
    (yield* readBuiltDays).map((row) => [row.day, row.buildVersion])
  )
  // A WIB date is ISO, so a later one sorts after.
  const due = days
    .filter((day) => (versions.get(day) ?? -1) < BROKER_TOTALS_VERSION)
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, POKES_PER_RUN)
  // A day whose poke failed is listed again tomorrow.
  for (const day of due)
    yield* poke(day).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Broker totals not poked", cause).pipe(
          Effect.annotateLogs({ day })
        )
      )
    )
  yield* Effect.logInfo("Broker totals reconciled").pipe(
    Effect.annotateLogs({ listedDays: days.length, pokedDays: due.length })
  )
})
