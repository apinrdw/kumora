import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { CommandFailed, gitLines } from "./command.mts"
import { recordingSpawner } from "./testing.mts"

describe("gitLines", () => {
  it.effect("returns git's stdout lines when it exits 0", () => {
    const spawner = recordingSpawner(() => ({ stdout: "a.ts\nb.ts\n" }))
    return Effect.gen(function* () {
      const lines = yield* gitLines("/repo", ["ls-files"])
      assert.deepStrictEqual(lines, ["a.ts", "b.ts"])
      assert.strictEqual(spawner.calls[0]?.command, "git")
      assert.deepStrictEqual(spawner.calls[0]?.args, ["ls-files"])
      assert.strictEqual(spawner.calls[0]?.options.cwd, "/repo")
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect("fails with CommandFailed when git exits non-zero", () => {
    const spawner = recordingSpawner(() => ({
      exitCode: 128,
      stdout: "partial\n",
      stderr: "fatal: not a git repository\n",
    }))
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        gitLines("/repo", ["ls-files", "--stage"])
      )
      assert.instanceOf(error, CommandFailed)
      assert.strictEqual(error.command, "git ls-files --stage")
      assert.strictEqual(error.exitCode, 128)
      assert.strictEqual(error.stderr, "fatal: not a git repository\n")
    }).pipe(Effect.provide(spawner.layer))
  })
})
