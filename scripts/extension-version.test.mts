import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { CommandLine } from "effect/process"
import { TestConsole } from "effect/testing"

import { baseRef, checkExtensionVersion } from "./extension-version.mts"
import { CheckFailed } from "./lib/check.mts"
import { recordingSpawner } from "./lib/testing.mts"

const pkg = (version: string) => JSON.stringify({ name: "extension", version })

// A repo whose merge-base is `mb`, whose diff lists `changed`, and whose
// extension package.json reads `before` at mb and `after` at HEAD.
const repo = (changed: ReadonlyArray<string>, before: string, after: string) =>
  recordingSpawner(({ args }) => {
    if (args[0] === "merge-base") return { stdout: "mb\n" }
    if (args[0] === "diff")
      return { stdout: changed.map((file) => `${file}\n`).join("") }
    if (args[1] === "mb:apps/extension/package.json")
      return { stdout: pkg(before) }
    if (args[1] === "HEAD:apps/extension/package.json")
      return { stdout: pkg(after) }
    return {
      exitCode: 128,
      stderr: `unexpected git ${CommandLine.display(args)}`,
    }
  })

describe("checkExtensionVersion", () => {
  it.effect("fails when a source file changed and the version did not", () => {
    const git = repo(
      ["apps/extension/src/worker/ajaib.ts", "apps/extension/tests/a.test.ts"],
      "0.0.2",
      "0.0.2"
    )
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        checkExtensionVersion("/repo", "origin/main")
      )
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        "apps/extension/src/worker/ajaib.ts",
      ])
      assert.include(error.summary, 'Bump "version"')
      assert.include(error.summary, "0.0.2")
      assert.deepStrictEqual(git.calls[1]?.args, [
        "diff",
        "--name-only",
        "mb",
        "HEAD",
        "--",
        "apps/extension",
      ])
    }).pipe(Effect.provide(git.layer))
  })

  it.effect("passes when the version changed with the source", () => {
    const git = repo(
      ["apps/extension/src/worker/ajaib.ts", "apps/extension/package.json"],
      "0.0.2",
      "0.0.3"
    )
    return Effect.gen(function* () {
      yield* checkExtensionVersion("/repo", "origin/main")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Relay extension version bumped from 0.0.2 to 0.0.3.",
      ])
    }).pipe(Effect.provide(git.layer))
  })

  it.effect(
    "passes when only tests, docs and the Vitest config changed",
    () => {
      const git = repo(
        [
          "apps/extension/tests/ajaib.test.ts",
          "apps/extension/GLOSSARY.md",
          "apps/extension/vitest.config.ts",
        ],
        "0.0.2",
        "0.0.2"
      )
      return Effect.gen(function* () {
        yield* checkExtensionVersion("/repo", "origin/main")
        assert.deepStrictEqual(yield* TestConsole.logLines, [
          "No relay extension build inputs changed since origin/main.",
        ])
        assert.strictEqual(git.calls.length, 2)
      }).pipe(Effect.provide(git.layer))
    }
  )
})

describe("baseRef", () => {
  const withEnv = (env: Record<string, string>) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

  it.effect("is the PR's base branch on a pull_request run", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* baseRef, "origin/main")
    }).pipe(withEnv({ GITHUB_BASE_REF: "main" }))
  )

  it.effect("is staging when GITHUB_BASE_REF is empty or unset", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* baseRef.pipe(withEnv({ GITHUB_BASE_REF: "" })),
        "origin/staging"
      )
      assert.strictEqual(yield* baseRef.pipe(withEnv({})), "origin/staging")
    })
  )
})
