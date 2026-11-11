// A cached `test` must miss when a workspace dependency's source changes, so
// each package's test task has to reach a task in every package it depends on.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import { repoRoot } from "./lib/check.mts"
import { turboDryRun, type DryTask } from "./lib/turbo.mts"

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.String)
    ),
  })
)

const planTests = Effect.gen(function* () {
  return { root: yield* repoRoot, tasks: yield* turboDryRun(["test"]) }
})

const reachablePackages = (
  byId: ReadonlyMap<string, DryTask>,
  task: DryTask
): Set<string> => {
  const seen = new Set<string>()
  const stack = [...task.dependencies]
  while (stack.length > 0) {
    const next = byId.get(stack.pop() as string)
    if (next === undefined || seen.has(next.taskId)) continue
    seen.add(next.taskId)
    stack.push(...next.dependencies)
  }
  return new Set([...seen].map((id) => (byId.get(id) as DryTask).package))
}

const workspaceDependencies = Effect.fnUntraced(function* (
  root: string,
  task: DryTask
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifest = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(root, task.directory, "package.json"))
  )
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name)
})

layer(NodeServices.layer)("turbo test graph", (it) => {
  it.effect("turbo plans the test tasks", () =>
    Effect.gen(function* () {
      const { tasks } = yield* planTests
      assert.isTrue(tasks.some((task) => task.task === "test"))
    })
  )

  it.effect(
    "each test task depends on a task in every workspace dependency",
    () =>
      Effect.gen(function* () {
        const { root, tasks } = yield* planTests
        const byId = new Map(tasks.map((task) => [task.taskId, task]))
        const missing = yield* Effect.forEach(
          tasks.filter((task) => task.task === "test"),
          (task) =>
            Effect.gen(function* () {
              const reached = reachablePackages(byId, task)
              return (yield* workspaceDependencies(root, task))
                .filter((name) => !reached.has(name))
                .map((name) => `${task.taskId} ignores changes in ${name}`)
            })
        )
        assert.deepStrictEqual(missing.flat(), [])
      })
  )
})
