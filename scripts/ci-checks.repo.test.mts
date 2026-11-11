// `pnpm check` is what a contributor runs locally, and each CI job runs one
// `check:*` script, so local and CI checks are the same work only while
// `check` is exactly the union of the `check:*` scripts and those scripts
// leave out none of the turbo tasks or `scripts/check-*.mts` checks.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import { CHECK_KINDS, turboDryRun } from "./lib/turbo.mts"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)
const turboRun = /^turbo run (.+)$/

const rootScripts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { scripts } = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(
      path.resolve(import.meta.dirname, "../package.json")
    )
  )
  return scripts
})

const commands = (script: string) => script.split("&&").map((c) => c.trim())

// A script's commands, with each `pnpm <root script>` replaced by its own.
const expand = (scripts: Record<string, string>, name: string): Array<string> =>
  commands(scripts[name] ?? "").flatMap((command) => {
    const called = /^pnpm (\S+)$/.exec(command)?.[1]
    return called !== undefined && called in scripts
      ? expand(scripts, called)
      : [command]
  })

const checkScripts = (scripts: Record<string, string>) =>
  Object.keys(scripts).filter((name) => name.startsWith("check:"))

const turboTasks = (script: string) =>
  commands(script).flatMap((command) =>
    (turboRun.exec(command)?.[1] ?? "").split(/\s+/).filter((t) => t !== "")
  )

layer(NodeServices.layer)("check scripts", (it) => {
  it.effect("pnpm check runs exactly the union of the check:* scripts", () =>
    Effect.gen(function* () {
      const scripts = yield* rootScripts
      const parts = checkScripts(scripts)
      assert.deepStrictEqual(parts.sort(), ["check:static", "check:test"])
      assert.deepStrictEqual(
        expand(scripts, "check").sort(),
        parts.flatMap((name) => expand(scripts, name)).sort()
      )
    })
  )

  it.effect("each check:* script starts turbo once", () =>
    Effect.gen(function* () {
      const scripts = yield* rootScripts
      assert.deepStrictEqual(
        checkScripts(scripts).map((name) => [
          name,
          expand(scripts, name).filter((c) => turboRun.test(c)).length,
        ]),
        checkScripts(scripts).map((name) => [name, 1])
      )
    })
  )

  it.effect(
    "check:static runs every scripts/check-*.mts after its turbo run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const scripts = yield* rootScripts
        const checks = (yield* fs.readDirectory(import.meta.dirname))
          .filter((name) => /^check-[\w-]+\.mts$/.test(name))
          .map((name) => `node scripts/${name}`)
        assert.isAbove(checks.length, 0, "found a scripts/check-*.mts")
        const steps = expand(scripts, "check:static")
        const turbo = steps.findIndex((c) => turboRun.test(c))
        assert.deepStrictEqual(steps.slice(turbo + 1).sort(), checks.sort())
      })
  )

  it.effect(
    "check:static and check:test split every check task between them",
    () =>
      Effect.gen(function* () {
        const scripts = yield* rootScripts
        const ids = (tasks: ReadonlyArray<{ taskId: string }>) =>
          new Set(tasks.map(({ taskId }) => taskId))
        const wanted = yield* turboDryRun(
          CHECK_KINDS.flatMap((kind) => turboTasks(scripts[kind] ?? ""))
        )
        const staticTasks = yield* turboDryRun(
          turboTasks(scripts["check:static"] ?? "")
        )
        const testTasks = yield* turboDryRun(
          turboTasks(scripts["check:test"] ?? "")
        )
        const isUnitTest = (task: { task: string; package: string }) =>
          task.task === "test" && task.package !== "//"

        assert.isTrue(wanted.some(isUnitTest), "turbo plans a package test")
        assert.deepStrictEqual(
          [...ids(wanted)]
            .filter(
              (id) => !ids(staticTasks).has(id) && !ids(testTasks).has(id)
            )
            .sort(),
          []
        )
        assert.deepStrictEqual(
          [...ids(wanted.filter(isUnitTest))].sort(),
          [...ids(testTasks.filter(isUnitTest))].sort()
        )
        assert.deepStrictEqual(
          staticTasks.filter(isUnitTest).map(({ taskId }) => taskId),
          []
        )
        assert.deepStrictEqual(
          testTasks
            .filter(({ package: pkg }) => pkg === "//")
            .map(({ taskId }) => taskId),
          []
        )
      })
  )
})
