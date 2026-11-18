// The daily broker totals reconcile (spec apinrdw/kumora#437, "Dashboard:
// reconcile cron"): the day index's days against the broker totals DB's
// built days, each listed day that is unbuilt or built at an older build
// version poked to build on its trading day's alarm. ./cron.ts runs it on
// the Worker's bindings.
import type { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { BROKER_TOTALS_VERSION } from "./version.ts"
import { readBuiltDays } from "./db.ts"

// Decision: at most this many accepted pokes a run, newest first, so a
// build version bump or a backlog re-derives history at about 20 days a
// day and never bursts D1's writes. A day that answers it won't build (an
// unbuildable day, 204) or whose poke fails takes no slot, so days that
// never become buildable cannot starve older ones. See apinrdw/kumora#420.
const POKES_PER_RUN = 20

export const reconcileBrokerTotals = Effect.fnUntraced(function* <E, R>(
  // The day index's days.
  listed: Effect.Effect<ReadonlyArray<WibDate>, E, R>,
  // Asks one day's trading day to build; whether it will.
  poke: (day: WibDate) => Effect.Effect<boolean, unknown, R>
) {
  const days = yield* listed
  const versions = new Map(
    (yield* readBuiltDays).map((row) => [row.day, row.buildVersion])
  )
  // A WIB date is ISO, so a later one sorts after.
  const due = days
    .filter((day) => (versions.get(day) ?? -1) < BROKER_TOTALS_VERSION)
    .sort((a, b) => (a < b ? 1 : -1))
  let poked = 0
  let accepted = 0
  for (const day of due) {
    if (accepted === POKES_PER_RUN) break
    poked++
    // A day whose poke failed is listed again tomorrow.
    if (
      yield* poke(day).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Broker totals not poked", cause).pipe(
            Effect.annotateLogs({ day }),
            Effect.as(false)
          )
        )
      )
    )
      accepted++
  }
  yield* Effect.logInfo("Broker totals reconciled").pipe(
    Effect.annotateLogs({
      listedDays: days.length,
      pokedDays: poked,
      buildingDays: accepted,
    })
  )
})
