import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"

import { CheckFailed } from "./lib/check.mts"
import { recordingSpawner } from "./lib/testing.mts"
import { checkNoGitlinks } from "./no-gitlinks.mts"

const index = (...lines: ReadonlyArray<string>) =>
  recordingSpawner(() => ({
    stdout: lines.map((line) => `${line}\n`).join(""),
  }))

describe("checkNoGitlinks", () => {
  it.effect("passes on an index with no submodule entries", () => {
    const git = index(
      "100644 aaa 0\tpackage.json",
      "100755 bbb 0\tscripts/x.sh"
    )
    return Effect.gen(function* () {
      yield* checkNoGitlinks("/repo")
      assert.deepStrictEqual(git.calls[0]?.args, ["ls-files", "--stage"])
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "No submodule entries in the index.",
      ])
    }).pipe(Effect.provide(git.layer))
  })

  it.effect("fails with CheckFailed naming each submodule entry", () => {
    const git = index(
      "100644 aaa 0\tpackage.json",
      "160000 ccc 0\trepos/alchemy/submodules/a",
      "160000 ddd 0\trepos/alchemy/submodules/b"
    )
    return Effect.gen(function* () {
      const error = yield* Effect.flip(checkNoGitlinks("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        "repos/alchemy/submodules/a",
        "repos/alchemy/submodules/b",
      ])
      assert.include(error.summary, "git rm --cached")
    }).pipe(Effect.provide(git.layer))
  })
})
