import { Effect, Schema } from "effect"

import { repoRoot } from "./check.mts"
import { stdoutOf } from "./command.mts"

// The turbo tasks that each run one kind of check: the root vp-check (lint,
// format and types for the whole tree), each package's build and test, and the
// root tests (package.json).
export const CHECK_KINDS = [
  "vp-check",
  "build",
  "test",
  "test:root",
  "test:repo",
] as const

// One task a turbo dry run plans: the fields the repo tests read.
const DryTask = Schema.Struct({
  taskId: Schema.String,
  task: Schema.String,
  package: Schema.String,
  directory: Schema.String,
  command: Schema.String,
  dependencies: Schema.Array(Schema.String),
  inputs: Schema.Record(Schema.String, Schema.String),
})
export type DryTask = typeof DryTask.Type

const DryRun = Schema.fromJsonString(
  Schema.Struct({ tasks: Schema.Array(DryTask) })
)

// The tasks `turbo run <tasks>` plans from the repo root, run as a dry run.
export const turboDryRun = Effect.fn("turboDryRun")(function* (
  tasks: ReadonlyArray<string>
) {
  const dryRun = yield* stdoutOf(
    "vp",
    ["exec", "turbo", "run", ...tasks, "--dry=json"],
    { cwd: yield* repoRoot }
  )
  return (yield* Schema.decodeEffect(DryRun)(dryRun)).tasks
})
