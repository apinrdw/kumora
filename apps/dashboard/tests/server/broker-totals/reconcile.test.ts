// Spec apinrdw/kumora#437, "Dashboard: reconcile cron": the daily reconcile
// compares the day index with the built days and pokes each listed day that
// is unbuilt or built at an older build version, newest first, at most 20 a
// run. Each fake poke builds its day, as the trading day's alarm would.
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { writeBuiltDay } from "@/server/broker-totals/db"
import { reconcileBrokerTotals } from "@/server/broker-totals/reconcile"
import { BROKER_TOTALS_VERSION } from "@/server/market-live/broker-totals"

import { memoryBrokerTotalsDb } from "./memory-broker-totals-db.ts"

const oct = (day: number) =>
  WibDate.make(`2026-10-${String(day).padStart(2, "0")}`)
const BUILT_AT = DateTime.makeUnsafe("2026-10-31T11:00:00Z")
const NO_ROWS = { totals: [], candles: [] }

// October 1..30, newest first, as the day strip lists them.
const LISTED = Array.from({ length: 30 }, (_, at) => oct(30 - at))

const reconciler = (
  db: ReturnType<typeof memoryBrokerTotalsDb>,
  failing: ReadonlySet<WibDate> = new Set()
) => {
  const poked: Array<WibDate> = []
  const poke = (day: WibDate) =>
    Effect.gen(function* () {
      poked.push(day)
      if (failing.has(day)) return yield* Effect.fail("Poke refused")
      yield* writeBuiltDay(day, NO_ROWS, BROKER_TOTALS_VERSION, BUILT_AT)
    }).pipe(Effect.provide(db.layer))
  const run = Effect.gen(function* () {
    poked.length = 0
    yield* reconcileBrokerTotals(Effect.succeed(LISTED), poke).pipe(
      Effect.provide(db.layer)
    )
    return [...poked]
  })
  return run
}

const built = (
  db: ReturnType<typeof memoryBrokerTotalsDb>,
  days: ReadonlyArray<number>,
  version: number
) =>
  Effect.forEach(days, (day) =>
    writeBuiltDay(oct(day), NO_ROWS, version, BUILT_AT)
  ).pipe(Effect.provide(db.layer))

describe("the broker totals reconcile", () => {
  it.effect(
    "pokes unbuilt and older-version days, at most 20 a run, newest first, and a rerun pokes nothing new",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        yield* built(db, [30, 28], BROKER_TOTALS_VERSION)
        yield* built(db, [29, 27], BROKER_TOTALS_VERSION - 1)
        const run = reconciler(db)

        assert.deepStrictEqual(
          yield* run,
          [
            29, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12,
            11, 10, 9,
          ].map(oct)
        )
        assert.deepStrictEqual(yield* run, [8, 7, 6, 5, 4, 3, 2, 1].map(oct))
        assert.deepStrictEqual(yield* run, [])
      })
  )

  it.effect("pokes the rest when one poke fails", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      yield* built(
        db,
        Array.from({ length: 27 }, (_, at) => at + 1),
        BROKER_TOTALS_VERSION
      )
      const run = reconciler(db, new Set([oct(29)]))

      assert.deepStrictEqual(yield* run, [30, 29, 28].map(oct))
      assert.deepStrictEqual(yield* run, [29].map(oct))
    })
  )
})
