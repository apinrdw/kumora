import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import { KSEI_CRON } from "@/server/ksei/schedule"
import { ARCHIVE_CRON } from "@/server/shareholding/schedule"

// Each archive's cron handler, which a firing starts a run through.
const runKseiCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
const runArchiveCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
vi.mock("@/server/ksei/cron", () => ({ runKseiCron }))
vi.mock("@/server/shareholding/cron", () => ({ runArchiveCron }))

const { runCron } = await import("@/server/crons")

const scheduledTime = Date.parse("2026-11-14T03:00:00Z")

afterEach(() => {
  vi.clearAllMocks()
})

describe("a cron firing", () => {
  it.effect("starts a KSEI archive run, and no other, on the KSEI cron", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runCron(KSEI_CRON, scheduledTime))

      assert.deepStrictEqual(runKseiCron.mock.calls, [[scheduledTime]])
      assert.strictEqual(runArchiveCron.mock.calls.length, 0)
    })
  )

  it.effect(
    "starts a shareholding archive run, and no KSEI one, on the IDX cron",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runCron(ARCHIVE_CRON, scheduledTime))

        assert.deepStrictEqual(runArchiveCron.mock.calls, [[scheduledTime]])
        assert.strictEqual(runKseiCron.mock.calls.length, 0)
      })
  )
})
