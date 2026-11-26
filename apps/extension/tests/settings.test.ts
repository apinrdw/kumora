import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { StageUrl } from "@workspace/deploy/stage-url"
import { WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import {
  historyCatchUpStore,
  loadSettings,
  saveSettings,
} from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the stored settings", () => {
  it.effect("keep an extra target's path", () =>
    Effect.gen(function* () {
      memorySession()
      const settings = {
        productionToken: "production-token",
        extra: {
          url: StageUrl.make("https://staging.example/dashboard"),
          token: "extra-token",
        },
      }
      yield* saveSettings(settings)
      assert.deepStrictEqual(yield* loadSettings, settings)
    })
  )

  // Codex review round 2 (PR #696): an extra target saved by its origin alone
  // was sent to at the root, which a dashboard under its base path answers
  // 301.
  it.effect(
    "load an extra target an earlier relay saved by its origin under the dashboard base path",
    () =>
      Effect.gen(function* () {
        memorySession()
        yield* Effect.promise(() =>
          chrome.storage.local.set({
            settings: {
              productionToken: "production-token",
              extra: {
                origin: "https://staging.example",
                token: "extra-token",
              },
            },
          })
        )
        assert.deepStrictEqual(yield* loadSettings, {
          productionToken: "production-token",
          extra: {
            url: StageUrl.make("https://staging.example/dashboard"),
            token: "extra-token",
          },
        })
      })
  )

  it.effect(
    "carry on the catch-up an earlier relay kept for an extra target's origin",
    () =>
      Effect.gen(function* () {
        memorySession()
        const day = WibDate.make("2026-11-12")
        yield* Effect.promise(() =>
          chrome.storage.local.set({
            settings: {
              productionToken: "",
              extra: { origin: "https://staging.example", token: "t" },
            },
            brokerCodesHistoryTradesCatchUp: {
              origin: "https://staging.example",
              value: day,
            },
          })
        )
        const store = yield* historyCatchUpStore(
          Effect.map(loadSettings, (settings) =>
            Option.map(Option.fromNullOr(settings.extra), ({ url }) => url)
          )
        )
        assert.deepStrictEqual(yield* store.load, Option.some(day))
      })
  )
})
