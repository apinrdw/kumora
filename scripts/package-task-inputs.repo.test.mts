// A Markdown-only edit, such as a GLOSSARY change, must not rerun a package's
// checks, so no package task CI runs, nor a task one depends on (test's
// transit), may hash a Markdown file. The root vp check task lints, formats and
// type-checks the whole tree, Markdown included, so it must hash every file.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { stdoutOf } from "./lib/command.mts"
import { CHECK_KINDS, turboDryRun } from "./lib/turbo.mts"

const markdownFile = /\.md$/

const trackedFiles = Effect.gen(function* () {
  return (yield* stdoutOf("git", ["ls-files", "-z"], { cwd: yield* repoRoot }))
    .split("\0")
    .filter((file) => file !== "")
})

layer(NodeServices.layer)("package task inputs", (it) => {
  it.effect("no package task hashes a Markdown file", () =>
    Effect.gen(function* () {
      const root = yield* repoRoot
      const markdown = (yield* stdoutOf(
        "git",
        ["ls-files", "--", "apps/*/**.md", "packages/*/**.md"],
        { cwd: root }
      ))
        .split("\n")
        .filter((file) => file !== "")
      assert.isAbove(markdown.length, 0, "found Markdown in a package")

      const tasks = yield* turboDryRun(CHECK_KINDS)
      const checked = tasks.filter((task) => task.package !== "//")
      assert.includeMembers(
        [...new Set(checked.map((task) => task.task))],
        ["build", "test"]
      )
      assert.deepStrictEqual(
        checked.flatMap((task) =>
          Object.keys(task.inputs)
            .filter((file) => markdownFile.test(file))
            .map((file) => `${task.taskId} hashes ${file}`)
        ),
        []
      )
    })
  )

  it.effect("the root vp check task hashes every tracked file", () =>
    Effect.gen(function* () {
      const tracked = yield* trackedFiles
      const planned = (yield* turboDryRun(["vp-check"])).find(
        ({ taskId }) => taskId === "//#vp-check"
      )
      assert.isDefined(planned, "turbo plans //#vp-check")
      const inputs = new Set(Object.keys(planned?.inputs ?? {}))
      assert.includeMembers(tracked, ["vite.config.ts", "AGENTS.md"])
      assert.deepStrictEqual(
        tracked.filter((file) => !inputs.has(file)),
        []
      )
    })
  )
})
