import { assert, describe, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestConsole } from "effect/testing"

import type { Stacks } from "../src/stacks.ts"
import { teardownCommand } from "../src/teardown-command.ts"
import { cliTestLayer, fakeStacks } from "./support.ts"

const run = (args: ReadonlyArray<string>, stacks: Layer.Layer<Stacks>) =>
  Command.runWith(teardownCommand, { version: "test" })(args).pipe(
    Effect.provide(Layer.merge(cliTestLayer, stacks))
  )

// A Preview of the branch "feature/login" (see target.test.ts).
const preview = "feature-login-df7c7a"

describe("teardown stage", () => {
  it.effect("prints a branch's Preview as a GitHub output line", () =>
    Effect.gen(function* () {
      yield* run(["stage", "feature/login"], fakeStacks().layer)
      assert.deepStrictEqual(yield* TestConsole.logLines, [`stage=${preview}`])
    })
  )

  it.effect.each(["main", "staging"])(
    "refuses %s and writes nothing to stdout",
    (branch) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          run(["stage", branch], fakeStacks().layer)
        )
        assert.strictEqual(error._tag, "NotAPreview")
        assert.deepStrictEqual(yield* TestConsole.logLines, [])
      })
  )
})

describe("teardown destroy", () => {
  it.effect("destroys every app of a Preview", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      yield* run(["destroy", preview], stacks.layer)
      assert.deepStrictEqual(stacks.destroyed, [
        ["web", preview],
        ["dashboard", preview],
      ])
    })
  )

  it.effect.each(["production", "staging"])(
    "refuses %s with NotAPreview and destroys nothing",
    (stage) =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        const error = yield* Effect.flip(run(["destroy", stage], stacks.layer))
        assert.strictEqual(error._tag, "NotAPreview")
        assert.strictEqual(
          error.message,
          `Refusing to tear down stage "${stage}": not a preview.`
        )
        assert.deepStrictEqual(stacks.destroyed, [])
      })
  )

  it.effect("fails with UnknownStage on a name no branch maps to", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      const error = yield* Effect.flip(
        run(["destroy", "live_jarvis"], stacks.layer)
      )
      assert.strictEqual(error._tag, "UnknownStage")
      assert.deepStrictEqual(stacks.destroyed, [])
    })
  )

  it.effect("still destroys the other app when one fails, then lists it", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks({ failing: { web: "state store unreachable" } })
      const error = yield* Effect.flip(run(["destroy", preview], stacks.layer))
      assert.deepStrictEqual(stacks.destroyed, [["dashboard", preview]])
      assert.strictEqual(error._tag, "TeardownFailed")
      assert.strictEqual(
        error.message,
        `Tearing down stage "${preview}" failed:\n  web: state store unreachable`
      )
    })
  )

  it.effect("lists every app that failed", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks({
        failing: { web: "first", dashboard: "second" },
      })
      const error = yield* Effect.flip(run(["destroy", preview], stacks.layer))
      assert.strictEqual(
        error.message,
        `Tearing down stage "${preview}" failed:\n  web: first\n  dashboard: second`
      )
    })
  )
})
