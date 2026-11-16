// The stock page's KSEI series, read after a real KSEI parse run parsed the
// holdings fixtures (May, Aug, Sep and Oct 2026: June and July are a gap).
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { stockPage } from "@/server/holdings/stock-page"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { kseiParseRuns } from "@/server/ksei/parse-runs"

import { localSteps } from "../archive/local-steps.ts"
import { memoryBucket } from "../archive/memory-bucket.ts"
import { holdingsKsei } from "../ksei/fake-ksei.ts"
import { memoryHoldingsDb } from "./memory-holdings-db.ts"

const parsed = Effect.gen(function* () {
  const bucket = memoryBucket()
  const holdings = memoryHoldingsDb()
  const run = (id: string) => ({
    id: RunId.make(id),
    trigger: "cron" as const,
    startedAt: new Date("2026-11-14T03:00:00Z"),
  })
  yield* TestClock.adjust("1 hour")
  yield* kseiArchiveRun(
    localSteps(Layer.merge(holdingsKsei().layer, bucket.layer)),
    run("cron-2026-11-14T03")
  )
  yield* TestClock.adjust("1 hour")
  yield* kseiParseRuns.run(
    localSteps(Layer.merge(bucket.layer, holdings.layer)),
    run("cron-2026-11-14T04")
  )
  return holdings.layer
})

const series = (code: string) =>
  Effect.gen(function* () {
    const layer = yield* parsed
    return (yield* stockPage(StockCode.make(code), undefined).pipe(
      Effect.provide(layer)
    )).series
  })

describe("the stock page's KSEI series", () => {
  it.effect("runs from the stock's first to its last month, gaps marked", () =>
    Effect.gen(function* () {
      const months = yield* series("BBCA")
      assert.deepStrictEqual(
        months.map(({ month, holdings }) => [month, holdings?.periodEnd]),
        [
          ["2026-05", "2026-05-29"],
          ["2026-06", undefined],
          ["2026-07", undefined],
          ["2026-08", "2026-08-31"],
          ["2026-09", "2026-09-30"],
          ["2026-10", "2026-10-30"],
        ]
      )
    })
  )

  it.effect("reads each month's holdings by origin and investor type", () =>
    Effect.gen(function* () {
      const october = (yield* series("BBCA")).at(-1)?.holdings
      // BBCA's October row in KSEI's report.
      assert.deepStrictEqual(october?.local, {
        ID: 12_030_567_470,
        CP: 752_250_260,
        MF: 1_072_720_030,
        IB: 517_672_400,
        IS: 2_310_613_490,
        SC: 119_977_978,
        PF: 302_459_300,
        FD: 72_753_960,
        OT: 15_254_200,
      })
      assert.strictEqual(october?.foreign.ID, 324_800_480)
      // A type holding nothing reads 0: APOL's local IS and MF.
      const apol = (yield* series("APOL")).at(-1)?.holdings
      assert.strictEqual(apol?.local.IS, 0)
      assert.strictEqual(apol?.local.CP, 647_104_480)
    })
  )

  it.effect("reads no series for a stock KSEI's reports don't have", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* series("ZZZZ"), [])
    })
  )
})
