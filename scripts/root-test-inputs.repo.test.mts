// A cached root test task must miss when a file one of its tests reads
// changes, so each task's inputs must hold every file its tests read: the test
// itself, the root Vitest config, each repo file a test opens by path, and the
// files a tool it spawns reads on its own.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

import { repoRoot } from "./lib/check.mts"
import { stdoutOf } from "./lib/command.mts"

const rootTestTasks = ["test:root", "test:repo"]

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)
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
const Listed = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ file: Schema.String }))
)
const Projects = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ path: Schema.String }))
)

const repoRead = /path\.resolve\(\s*import\.meta\.dirname,\s*"\.\.\/([^"]+)"/g
const spawned = /"(?:[^"\s]*\/)?(turbo|pnpm|oxlint)"/g
const vitestRun = /^vitest run (.+)$/

// The files under `target`, or `target` itself when it is a file.
const filesAt = Effect.fnUntraced(function* (root: string, target: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if ((yield* fs.stat(path.join(root, target))).type !== "Directory")
    return [target]
  const files: Array<string> = []
  for (const file of yield* fs.readDirectory(path.join(root, target), {
    recursive: true,
  })) {
    const full = path.join(root, target, file)
    if ((yield* fs.stat(full)).type === "File")
      files.push(path.relative(root, full))
  }
  return files
})

// The repo files each tool reads without a test naming them.
const toolReads = Effect.gen(function* () {
  const path = yield* Path.Path
  const root = yield* repoRoot
  const projects = yield* Schema.decodeEffect(Projects)(
    yield* stdoutOf("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
      cwd: root,
    })
  )
  const manifests = projects.map(({ path: dir }) =>
    path.relative(root, path.join(dir, "package.json"))
  )
  const workspace = ["pnpm-workspace.yaml", ...manifests]
  const reads: Record<string, ReadonlyArray<string>> = {
    turbo: ["turbo.json", "pnpm-lock.yaml", ...workspace],
    pnpm: workspace,
    oxlint: [".oxlintrc.json"],
  }
  return reads
})

// The test files a root test task runs, as Vitest lists them for its script.
const testFiles = Effect.fnUntraced(function* (task: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* repoRoot
  const { scripts } = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(root, "package.json"))
  )
  const args = vitestRun.exec(scripts[task] ?? "")?.[1]
  assert.isDefined(args, `the ${task} script is a vitest run`)
  const listed = yield* stdoutOf(
    "pnpm",
    [
      "exec",
      "vitest",
      "list",
      ...(args ?? "").split(/\s+/).map((arg) => arg.replace(/^"(.*)"$/, "$1")),
      "--filesOnly",
      "--json",
    ],
    { cwd: root }
  )
  return (yield* Schema.decodeEffect(Listed)(listed)).map(({ file }) =>
    path.relative(root, file)
  )
})

const taskInputs = Effect.fnUntraced(function* (task: string) {
  const root = yield* repoRoot
  const dryRun = yield* stdoutOf(
    "pnpm",
    ["exec", "turbo", "run", task, "--dry=json"],
    { cwd: root }
  )
  const { tasks } = yield* Schema.decodeEffect(DryRun)(dryRun)
  const planned = tasks.find(({ taskId }) => taskId === `//#${task}`)
  assert.isDefined(planned, `turbo plans //#${task}`)
  return new Set(Object.keys(planned?.inputs ?? {}))
})

const filesRead = Effect.fnUntraced(function* (tests: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* repoRoot
  const tools = yield* toolReads
  const read = new Set(
    (yield* fs.readDirectory(root)).filter((name) =>
      /^vitest\.config\.[cm]?[jt]s$/.test(name)
    )
  )
  assert.isAbove(read.size, 0, "found the root Vitest config")
  for (const test of tests) {
    read.add(test)
    const source = yield* fs.readFileString(path.join(root, test))
    for (const [, target] of source.matchAll(repoRead))
      for (const file of yield* filesAt(root, target as string)) read.add(file)
    for (const [, tool] of source.matchAll(spawned))
      for (const file of tools[tool as string] ?? []) read.add(file)
  }
  return read
})

layer(NodeServices.layer)("root test inputs", (it) => {
  it.effect("every root test runs in exactly one root test task", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tests = (yield* fs.readDirectory(import.meta.dirname, {
        recursive: true,
      }))
        .filter((name) => name.endsWith(".test.mts"))
        .map((name) => `scripts/${name}`)
      const ran = (yield* Effect.forEach(rootTestTasks, testFiles)).flat()
      assert.isAbove(tests.length, 0, "found a root test")
      assert.deepStrictEqual(ran.sort(), tests.sort())
    })
  )

  for (const task of rootTestTasks)
    it.effect(`every file a ${task} test reads is a //#${task} input`, () =>
      Effect.gen(function* () {
        const inputs = yield* taskInputs(task)
        const tests = yield* testFiles(task)
        assert.isAbove(tests.length, 0, `${task} runs a test`)
        const read = yield* filesRead(tests)
        assert.deepStrictEqual(
          [...read].filter((file) => !inputs.has(file)).sort(),
          []
        )
      })
    )
})
