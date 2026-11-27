import { assert, describe, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestConsole } from "effect/testing"

import { report, stderrPresenter } from "../src/report.ts"
import { Stage } from "../src/target.ts"
import { NotAPreview, teardownCommand } from "../src/teardown-command.ts"
import { fakeStacks, teardownTestLayer } from "./support.ts"

// What an entry point runs, minus BunRuntime: the command, reported.
const teardown = (args: ReadonlyArray<string>) =>
  Command.runWith(teardownCommand, { version: "test" })(args).pipe(
    report,
    Effect.provide(
      Layer.merge(teardownTestLayer(fakeStacks().layer), stderrPresenter)
    ),
    Effect.exit
  )

describe("report", () => {
  it.effect("prints a typed failure's message to stderr only", () =>
    Effect.gen(function* () {
      yield* Effect.exit(
        report(Effect.fail(new NotAPreview({ stage: Stage.make("staging") })))
      )
      assert.deepStrictEqual(yield* TestConsole.errorLines, [
        'Refusing to tear down stage "staging": not a preview.',
      ])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
    })
  )

  it.effect("prints nothing for an interrupt", () =>
    Effect.gen(function* () {
      yield* Effect.exit(report(Effect.interrupt))
      assert.deepStrictEqual(yield* TestConsole.errorLines, [])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
    })
  )

  it.effect("teardown stage on a bad branch writes nothing to stdout", () =>
    Effect.gen(function* () {
      yield* teardown(["stage", "main"])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
      assert.deepStrictEqual(yield* TestConsole.errorLines, [
        'Refusing to tear down stage "production": not a preview.',
      ])
    })
  )

  it.effect("a bad invocation prints its usage to stderr, not stdout", () =>
    Effect.gen(function* () {
      yield* teardown(["stage"])
      assert.deepStrictEqual(yield* TestConsole.logLines, [])
      const stderr = (yield* TestConsole.errorLines).join("\n")
      assert.include(stderr, "USAGE")
      assert.include(stderr, "branch")
    })
  )
})
