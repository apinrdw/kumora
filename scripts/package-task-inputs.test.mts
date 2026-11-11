// A Markdown-only edit, such as a GLOSSARY change, must not rerun a package's
// checks, so no package task CI runs, nor a task one depends on (test's
// transit), may hash a Markdown file.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { repoRoot } from "./lib/check.mts"
import { stdoutOf } from "./lib/command.mts"

const kinds = ["typecheck", "build", "lint", "format:check", "test"]

const DryRun = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        task: Schema.String,
        package: Schema.String,
        inputs: Schema.Record(Schema.String, Schema.String),
      })
    ),
  })
)

const markdownFile = /\.md$/

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

      const { tasks } = yield* Schema.decodeEffect(DryRun)(
        yield* stdoutOf(
          "pnpm",
          ["exec", "turbo", "run", ...kinds, "--dry=json"],
          {
            cwd: root,
          }
        )
      )
      const checked = tasks.filter((task) => task.package !== "//")
      assert.includeMembers(
        [...new Set(checked.map((task) => task.task))],
        kinds
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
})
