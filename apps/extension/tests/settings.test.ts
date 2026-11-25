import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Effect } from "effect"

import { DashboardUrl, loadSettings } from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the stored settings", () => {
  it.effect("load an extra target an earlier relay saved by its origin", () =>
    Effect.gen(function* () {
      memorySession()
      yield* Effect.promise(() =>
        chrome.storage.local.set({
          settings: {
            productionToken: "production-token",
            extra: { origin: "https://staging.example", token: "extra-token" },
          },
        })
      )
      assert.deepStrictEqual(yield* loadSettings, {
        productionToken: "production-token",
        extra: {
          url: DashboardUrl.make("https://staging.example"),
          token: "extra-token",
        },
      })
    })
  )
})
