import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, Path } from "effect"
import { ChildProcess } from "effect/process"

import { collect } from "./command.mts"

const runFixture = Effect.fnUntraced(function* (outcome: string) {
  const path = yield* Path.Path
  const fixture = path.join(import.meta.dirname, "run.fixture.mts")
  return yield* collect(ChildProcess.make("node", [fixture, outcome]))
})

layer(NodeServices.layer)("runScript", (it) => {
  it.effect("a success exits 0 with the program's own output", () =>
    Effect.gen(function* () {
      const result = yield* runFixture("succeed")
      assert.deepStrictEqual(result, {
        exitCode: 0,
        stdout: "done\n",
        stderr: "",
      })
    })
  )

  it.effect("a typed failure prints its message to stderr and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runFixture("fail")
      assert.deepStrictEqual(result, {
        exitCode: 1,
        stdout: "",
        stderr: "Two things are wrong:\nfirst\nsecond\n",
      })
    })
  )

  it.effect("a defect prints the full cause to stderr and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runFixture("die")
      assert.strictEqual(result.exitCode, 1)
      assert.strictEqual(result.stdout, "")
      assert.include(result.stderr, "Error: boom")
      assert.match(result.stderr, /\n\s+at /)
    })
  )
})
