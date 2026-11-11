import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { specTimes } from "./ci-timings.mts"

const log = [
  "2026-11-11T18:34:24.3556474Z ##[group]Run pnpm test:e2e --shard=4/6",
  "2026-11-11T18:35:20.1000000Z   ✓  1 [setup] › tests/accounts.setup.ts:9:3 › sign up and verify admin@example.com (28.9s)",
  "2026-11-11T18:35:21.0000000Z   ✓  2 [setup] › tests/accounts.setup.ts:9:3 › sign up and verify member@example.com (28.9s)",
  "2026-11-11T18:35:40.0000000Z   ✘  3 [trading-day] › tests/market-live-recorded.spec.ts:40:1 › replays a recorded day (1.2m)",
  "2026-11-11T18:35:41.0000000Z   ✓  4 [chromium] › tests/web.spec.ts:7:1 › GET / serves the landing page (406ms)",
  "2026-11-11T18:35:42.0000000Z   2 passed (1.5m)",
].join("\n")

describe("specTimes", () => {
  it.effect("sums each spec's test seconds, slowest first", () =>
    Effect.gen(function* () {
      const { specs } = yield* specTimes(log, "2026-11-11T18:34:24Z")
      assert.deepStrictEqual(
        specs.map(([spec, s]) => [spec, Number(s.toFixed(3))]),
        [
          ["tests/market-live-recorded.spec.ts", 72],
          ["tests/accounts.setup.ts", 57.8],
          ["tests/web.spec.ts", 0.406],
        ]
      )
    })
  )

  it.effect(
    "counts finished tests, failed ones included, and not the summary line",
    () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* specTimes(log, null)).tests, 4)
      })
  )

  it.effect("times the first finished test from the test step's start", () =>
    Effect.gen(function* () {
      const timed = yield* specTimes(log, "2026-11-11T18:34:24Z")
      assert.strictEqual(Math.round(timed.firstTestAfter ?? -1), 56)
      assert.strictEqual(
        (yield* specTimes(log, null)).firstTestAfter,
        undefined
      )
    })
  )
})
