// Spec apinrdw/kumora#437, "Dashboard: reconcile cron": the daily reconcile
// compares the day index with the built days and pokes each listed day that
// is unbuilt or built at an older build version, newest first, at most 20 a
// run that a day accepts. Each fake poke builds its day, as the trading day's
// alarm would, unless the test makes it unbuildable or failing.
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { writeBuiltDay } from "@/server/broker-totals/db"
import { reconcileBrokerTotals } from "@/server/broker-totals/reconcile"
import { BROKER_TOTALS_VERSION } from "@/server/broker-totals/version"

import { memoryBrokerTotalsDb } from "./memory-broker-totals-db.ts"

const oct = (day: number) =>
  WibDate.make(`2026-10-${String(day).padStart(2, "0")}`)
const BUILT_AT = DateTime.makeUnsafe("2026-10-31T11:00:00Z")
const NO_ROWS = { totals: [], candles: [], missingTrades: 0 }

// The last build version whose totals had no trades bought and sold.
const BEFORE_FREQ = 1

// October 1..30, newest first, as the day strip lists them.
const LISTED = Array.from({ length: 30 }, (_, at) => oct(30 - at))

const reconciler = (
  db: ReturnType<typeof memoryBrokerTotalsDb>,
  {
    failing = new Set(),
    unbuildable = new Set(),
    listed = LISTED,
  }: {
    readonly failing?: ReadonlySet<WibDate>
    // Days whose trading day answers 204: it will never build them.
    readonly unbuildable?: ReadonlySet<WibDate>
    readonly listed?: ReadonlyArray<WibDate>
  } = {}
) => {
  const poked: Array<WibDate> = []
  const poke = (day: WibDate) =>
    Effect.gen(function* () {
      poked.push(day)
      if (failing.has(day)) return yield* Effect.fail("Poke refused")
      if (unbuildable.has(day)) return false
      yield* writeBuiltDay(day, NO_ROWS, BROKER_TOTALS_VERSION, BUILT_AT)
      return true
    }).pipe(Effect.provide(db.layer))
  const run = Effect.gen(function* () {
    poked.length = 0
    yield* reconcileBrokerTotals(Effect.succeed(listed), poke).pipe(
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

  it.effect("pokes a day built before the trades bought and sold", () =>
    Effect.gen(function* () {
      const db = memoryBrokerTotalsDb()
      yield* built(db, [30], BEFORE_FREQ)
      assert.deepStrictEqual(yield* reconciler(db, { listed: [oct(30)] }), [
        oct(30),
      ])
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
      const run = reconciler(db, { failing: new Set([oct(29)]) })

      assert.deepStrictEqual(yield* run, [30, 29, 28].map(oct))
      assert.deepStrictEqual(yield* run, [29].map(oct))
    })
  )

  it.effect(
    "counts only pokes a day accepts against the 20, so days that never complete starve no older day",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        // November 1..25 never complete; October 28..30 are older builds.
        const november = Array.from({ length: 25 }, (_, at) =>
          WibDate.make(`2026-11-${String(25 - at).padStart(2, "0")}`)
        )
        yield* built(db, [30, 29, 28], BROKER_TOTALS_VERSION - 1)
        const run = reconciler(db, {
          unbuildable: new Set(november),
          listed: [...november, oct(30), oct(29), oct(28)],
        })

        assert.deepStrictEqual(yield* run, [
          ...november,
          ...[30, 29, 28].map(oct),
        ])
        assert.deepStrictEqual(yield* run, november)
      })
  )
})
