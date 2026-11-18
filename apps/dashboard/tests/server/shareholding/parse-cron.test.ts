// What a parse cron firing starts: a classification parse run, an
// investor-type parse run and an above-1% parse run, each apart from the
// others.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { ArchiveWorkflow } from "@/server/archive/workflow"
import { Above1ParseWorkflow } from "@/server/shareholding/above-1-parse"
import { ClassificationParseWorkflow } from "@/server/shareholding/classification-parse"
import { InvestorTypeParseWorkflow } from "@/server/shareholding/investor-type-parse"
import { scheduledParseRuns } from "@/server/shareholding/parse-runs"

import { fakeWorkflow } from "../archive/fake-workflow.ts"
import { memoryBucket } from "../archive/memory-bucket.ts"

const parseCron = () => {
  const bucket = memoryBucket()
  const classification = fakeWorkflow()
  const investorType = fakeWorkflow()
  const above1 = fakeWorkflow()
  return {
    bucket,
    classification,
    investorType,
    above1,
    layer: Layer.mergeAll(
      bucket.layer,
      Layer.effect(
        ClassificationParseWorkflow,
        Effect.service(ArchiveWorkflow)
      ).pipe(Layer.provide(classification.layer)),
      Layer.effect(
        InvestorTypeParseWorkflow,
        Effect.service(ArchiveWorkflow)
      ).pipe(Layer.provide(investorType.layer)),
      Layer.effect(Above1ParseWorkflow, Effect.service(ArchiveWorkflow)).pipe(
        Layer.provide(above1.layer)
      )
    ),
  }
}

// 21:00 WIB on 14 Nov 2026.
const firing = Date.parse("2026-11-14T14:00:00Z")

describe("the parse cron", () => {
  it.effect("starts a parse run of each kind, named by its date", () => {
    const { layer, classification, investorType, above1 } = parseCron()
    return Effect.gen(function* () {
      yield* TestClock.setTime(firing)
      yield* scheduledParseRuns(firing)
      for (const kind of [classification, investorType, above1])
        assert.deepStrictEqual([...kind.instances.keys()], ["cron-2026-11-14"])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "starts an investor-type parse run while a classification one runs",
    () => {
      const { layer, classification, investorType } = parseCron()
      return Effect.gen(function* () {
        yield* TestClock.setTime(firing)
        yield* scheduledParseRuns(firing)
        const running = classification.instances.get("cron-2026-11-14")
        assert.isDefined(running)
        running.status = "running"
        const done = investorType.instances.get("cron-2026-11-14")
        assert.isDefined(done)
        done.status = "complete"

        const next = firing + 24 * 60 * 60 * 1000
        yield* TestClock.setTime(next)
        yield* scheduledParseRuns(next)
        assert.deepStrictEqual(
          [...classification.instances.keys()],
          ["cron-2026-11-14"]
        )
        assert.deepStrictEqual(
          [...investorType.instances.keys()],
          ["cron-2026-11-14", "cron-2026-11-15"]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "starts the investor-type parse run when the classification one can't start",
    () => {
      const { layer, classification, investorType } = parseCron()
      classification.refuseCreate = true
      return Effect.gen(function* () {
        yield* TestClock.setTime(firing)
        const failure = yield* Effect.flip(scheduledParseRuns(firing))
        assert.strictEqual(failure._tag, "WorkflowError")
        assert.deepStrictEqual(
          [...investorType.instances.keys()],
          ["cron-2026-11-14"]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "starts the other two parse runs when the above-1% one can't start",
    () => {
      const { layer, classification, investorType, above1 } = parseCron()
      above1.refuseCreate = true
      return Effect.gen(function* () {
        yield* TestClock.setTime(firing)
        const failure = yield* Effect.flip(scheduledParseRuns(firing))
        assert.strictEqual(failure._tag, "WorkflowError")
        for (const kind of [classification, investorType])
          assert.deepStrictEqual(
            [...kind.instances.keys()],
            ["cron-2026-11-14"]
          )
      }).pipe(Effect.provide(layer))
    }
  )
})
