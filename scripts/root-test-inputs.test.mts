// A cached `//#test:root` must miss when a file a root test reads changes, so
// every repo path a root test resolves from `import.meta.dirname` has to be one
// of that task's inputs.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import { stdoutOf } from "./lib/command.mts"

const DryRun = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        inputs: Schema.Record(Schema.String, Schema.String),
      })
    ),
  })
)

const repoRead = /path\.resolve\(\s*import\.meta\.dirname,\s*"\.\.\/([^"]+)"/g

layer(NodeServices.layer)("root test inputs", (it) => {
  it.effect("every repo file a root test reads is a //#test:root input", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(import.meta.dirname, "..")
      const dryRun = yield* stdoutOf(
        "pnpm",
        ["exec", "turbo", "run", "test:root", "--dry=json"],
        { cwd: root }
      )
      const { tasks } = yield* Schema.decodeEffect(DryRun)(dryRun)
      const task = tasks.find(({ taskId }) => taskId === "//#test:root")
      assert.isDefined(task, "turbo plans //#test:root")
      const inputs = new Set(Object.keys(task?.inputs ?? {}))

      const tests = (yield* fs.readDirectory(import.meta.dirname)).filter(
        (name) => name.endsWith(".test.mts")
      )
      const read = new Set<string>()
      for (const test of tests) {
        const source = yield* fs.readFileString(
          path.join(import.meta.dirname, test)
        )
        for (const match of source.matchAll(repoRead)) {
          const target = match[1] as string
          const info = yield* fs.stat(path.join(root, target))
          if (info.type !== "Directory") {
            read.add(target)
            continue
          }
          const files = yield* fs.readDirectory(path.join(root, target), {
            recursive: true,
          })
          for (const file of files) {
            const full = path.join(root, target, file)
            if ((yield* fs.stat(full)).type === "File") {
              read.add(path.relative(root, full))
            }
          }
        }
      }
      assert.isAbove(read.size, 0, "found a repo file a root test reads")
      assert.deepStrictEqual(
        [...read].filter((file) => !inputs.has(file)).sort(),
        []
      )
    })
  )
})
