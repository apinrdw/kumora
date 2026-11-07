import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"

import { collect } from "./command.mts"

// Runs a script whose program is `body`, through runScript, in a real node.
const runScriptWith = (body: string) =>
  collect(
    ChildProcess.make(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          'import { Console, Effect } from "effect"',
          'import { CheckFailed } from "./check.mts"',
          'import { runScript } from "./run.mts"',
          `runScript(${body})`,
        ].join("\n"),
      ],
      { cwd: import.meta.dirname }
    )
  )

layer(NodeServices.layer)("runScript", (it) => {
  it.effect("a success exits 0 with the program's own output", () =>
    Effect.gen(function* () {
      const result = yield* runScriptWith('Console.log("done")')
      assert.deepStrictEqual(result, {
        exitCode: 0,
        stdout: "done\n",
        stderr: "",
      })
    })
  )

  it.effect("a typed failure prints its message to stderr and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runScriptWith(
        'Effect.fail(new CheckFailed({ summary: "Two things are wrong:", findings: ["first", "second"] }))'
      )
      assert.deepStrictEqual(result, {
        exitCode: 1,
        stdout: "",
        stderr: "Two things are wrong:\nfirst\nsecond\n",
      })
    })
  )

  it.effect("a defect prints the full cause to stderr and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runScriptWith('Effect.die(new Error("boom"))')
      assert.strictEqual(result.exitCode, 1)
      assert.strictEqual(result.stdout, "")
      assert.include(result.stderr, "Error: boom")
      assert.match(result.stderr, /\n\s+at /)
    })
  )
})
