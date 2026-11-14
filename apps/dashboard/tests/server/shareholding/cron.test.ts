import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { vi } from "vitest"

const unavailable = () =>
  Effect.runPromise(Effect.fail(new Error("R2 is unavailable")))

// The Worker's env, as the bridge's runner reads it, with R2 down.
vi.mock("cloudflare:workers", () => ({
  env: {
    SHAREHOLDING_ARCHIVE_BUCKET: {
      list: unavailable,
      head: unavailable,
      get: unavailable,
      put: unavailable,
    },
    SHAREHOLDING_ARCHIVE: { create: unavailable, get: unavailable },
  },
}))

const { runArchiveCron } = await import("@/server/shareholding/cron")

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the archive cron", () => {
  it.effect("logs a failed run and settles, as the bridge does", () =>
    Effect.gen(function* () {
      // The runtime's own logger writes to the console.
      const log = vi.spyOn(console, "log").mockImplementation(() => {})

      const settled = yield* Effect.tryPromise({
        try: () => runArchiveCron(Date.parse("2026-11-14T13:00:00Z")),
        catch: (error) =>
          assert.fail(`expected the cron to settle, but it rejected: ${error}`),
      })

      assert.isTrue(Result.isFailure(settled), "the cron's run failed")
      assert.include(log.mock.calls.flat(), "Server effect failed")
    })
  )
})
