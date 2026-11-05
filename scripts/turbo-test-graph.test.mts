// A cached `test` must miss when a workspace dependency's source changes, so
// each package's test task has to reach a task in every package it depends on.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const root = resolve(import.meta.dirname, "..")

interface DryTask {
  readonly taskId: string
  readonly task: string
  readonly package: string
  readonly directory: string
  readonly dependencies: ReadonlyArray<string>
}

const dryRun = spawnSync(
  "pnpm",
  ["exec", "turbo", "run", "test", "--dry=json"],
  {
    cwd: root,
    encoding: "utf8",
  }
)
const tasks: ReadonlyArray<DryTask> =
  dryRun.status === 0 ? JSON.parse(dryRun.stdout).tasks : []
const byId = new Map(tasks.map((task) => [task.taskId, task]))

function reachablePackages(task: DryTask): Set<string> {
  const seen = new Set<string>()
  const stack = [...task.dependencies]
  while (stack.length > 0) {
    const id = stack.pop() as string
    const next = byId.get(id)
    if (next === undefined || seen.has(next.taskId)) continue
    seen.add(next.taskId)
    stack.push(...next.dependencies)
  }
  return new Set([...seen].map((id) => (byId.get(id) as DryTask).package))
}

function workspaceDependencies(task: DryTask): string[] {
  const manifest = JSON.parse(
    readFileSync(join(root, task.directory, "package.json"), "utf8")
  )
  const all: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }
  return Object.entries(all)
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name)
}

test("turbo plans the test tasks", () => {
  assert.equal(dryRun.status, 0, dryRun.stderr)
  assert.ok(tasks.some((task) => task.task === "test"))
})

test("each test task depends on a task in every workspace dependency", () => {
  const missing = tasks
    .filter((task) => task.task === "test")
    .flatMap((task) => {
      const reached = reachablePackages(task)
      return workspaceDependencies(task)
        .filter((name) => !reached.has(name))
        .map((name) => `${task.taskId} ignores changes in ${name}`)
    })
  assert.deepEqual(missing, [])
})
