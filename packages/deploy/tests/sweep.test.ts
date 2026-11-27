import { assert, describe, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestConsole } from "effect/testing"

import type { Stacks } from "../src/stacks.ts"
import { teardownCommand } from "../src/teardown-command.ts"
import {
  cliTestLayer,
  fakeGitHub,
  fakeStacks,
  fakeStoredStages,
} from "./support.ts"

// Previews of live branches, worked out by hand (see target.test.ts).
const live = "feature-login-df7c7a" // feature/login
const gone = "feat-gone-e622ed" // feat/gone, deleted
const otherGone = "fix-old-push-00ea70" // fix/old-push, deleted

const sweep = (
  args: ReadonlyArray<string>,
  options: {
    readonly stacks: Layer.Layer<Stacks>
    readonly stored: Parameters<typeof fakeStoredStages>[0]
    readonly branches: ReadonlyArray<string>
  }
) =>
  Command.runWith(teardownCommand, { version: "test" })([
    "sweep",
    ...args,
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(
        cliTestLayer,
        options.stacks,
        fakeStoredStages(options.stored),
        fakeGitHub(options.branches)
      )
    )
  )

describe("teardown sweep", () => {
  it.effect(
    "destroys every app of a Preview whose branch is gone and keeps a live branch's",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: { web: [live, gone], dashboard: [live, gone] },
          branches: ["staging", "feature/login"],
        })
        assert.deepStrictEqual(stacks.destroyed, [
          ["web", gone],
          ["dashboard", gone],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `destroyed ${gone} (branch gone)`,
          `kept ${live} (branch feature/login is live)`,
        ])
      })
  )

  it.effect("a dry run destroys nothing and prints would-destroy lines", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep(["--dry-run"], {
        stacks: stacks.layer,
        stored: { web: [gone, live], dashboard: [otherGone] },
        branches: ["feature/login"],
      })
      assert.deepStrictEqual(stacks.destroyed, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        `would destroy ${gone} (branch gone)`,
        `kept ${live} (branch feature/login is live)`,
        `would destroy ${otherGone} (branch gone)`,
      ])
    })
  )

  it.effect(
    "never destroys a Release stage, the Test stage or a name that isn't a Preview",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        yield* sweep([], {
          stacks: stacks.layer,
          stored: {
            web: ["production", "staging", "test", "live_jarvis"],
            dashboard: ["dev_jarvis", "production"],
          },
          branches: [],
        })
        assert.deepStrictEqual(stacks.destroyed, [])
        assert.deepStrictEqual(yield* TestConsole.logLines, [])
      })
  )

  it.effect("destroys a Preview stored for only one app across every app", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep([], {
        stacks: stacks.layer,
        stored: { dashboard: [gone] },
        branches: [],
      })
      assert.deepStrictEqual(stacks.destroyed, [
        ["web", gone],
        ["dashboard", gone],
      ])
    })
  )

  it.effect(
    "still destroys the other app and the other Previews when one app fails, then lists it",
    () =>
      Effect.gen(function* () {
        const stacks = fakeStacks({
          failing: { web: "state store unreachable" },
        })
        const error = yield* Effect.flip(
          sweep([], {
            stacks: stacks.layer,
            stored: { web: [gone, otherGone, live] },
            branches: ["feature/login"],
          })
        )
        assert.deepStrictEqual(stacks.destroyed, [
          ["dashboard", gone],
          ["dashboard", otherGone],
        ])
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          `failed to destroy ${gone} (branch gone)`,
          `kept ${live} (branch feature/login is live)`,
          `failed to destroy ${otherGone} (branch gone)`,
        ])
        assert.strictEqual(error._tag, "SweepFailed")
        assert.strictEqual(
          error.message,
          [
            "Sweeping Previews failed:",
            `  ${gone} web: state store unreachable`,
            `  ${otherGone} web: state store unreachable`,
          ].join("\n")
        )
      })
  )

  it.effect("does nothing on an empty state store", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* sweep([], { stacks: stacks.layer, stored: {}, branches: [] })
      assert.deepStrictEqual(stacks.destroyed, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
    })
  )
})
