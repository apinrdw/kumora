// Where a workflow run's time went: each job's seconds and its slowest steps.
// `pnpm ci-timings <run-id>` (from `gh run list`) runs it, for a run of any
// workflow.
import { Console, Effect, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"
import { stdoutOf } from "./lib/command.mts"

const Step = Schema.Struct({
  name: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
})
const Job = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  steps: Schema.Array(Step),
})
const Jobs = Schema.Struct({ jobs: Schema.Array(Job) })
const Run = Schema.Struct({
  head_sha: Schema.String,
  created_at: Schema.String,
})

const seconds = Effect.fnUntraced(function* (
  from: string | null,
  to: string | null
) {
  return from === null || to === null
    ? 0
    : (Date.parse(to) - Date.parse(from)) / 1000
})

const api = Effect.fn("api")(function* (root: string, path: string) {
  return yield* stdoutOf("gh", ["api", `repos/{owner}/{repo}/${path}`], {
    cwd: root,
  })
})

const decode = Effect.fnUntraced(function* <S extends Schema.Top>(
  schema: S,
  json: string
) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(json)
})

const slowestSteps = Effect.fnUntraced(function* (job: typeof Job.Type) {
  const steps = yield* Effect.forEach(
    job.steps,
    Effect.fnUntraced(function* (step) {
      return {
        name: step.name.replace(/^Run /, "").slice(0, 40),
        s: yield* seconds(step.started_at, step.completed_at),
      }
    })
  )
  return steps
    .filter((step) => step.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((step) => `${step.name} ${step.s.toFixed(0)}`)
    .join("; ")
})

export const ciTimings = Effect.fn("ciTimings")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const [runId = ""] = args
  if (!/^\d+$/.test(runId))
    return yield* new CheckFailed({
      summary: "Usage: pnpm ci-timings <run-id>",
      findings: [],
    })
  const run = yield* decode(Run, yield* api(root, `actions/runs/${runId}`))
  const { jobs } = yield* decode(
    Jobs,
    yield* api(root, `actions/runs/${runId}/jobs?per_page=100`)
  )
  const end = jobs.map((job) => job.completed_at ?? job.started_at).sort()
  const runSeconds = yield* seconds(run.created_at, end.at(-1) ?? null)
  yield* Console.log(
    `Run ${runId} on ${run.head_sha.slice(0, 10)}: ${runSeconds.toFixed(0)} s from creation to the last job's end.\n\n| job | s | slowest steps (s) |\n|---|---|---|`
  )
  const timed = yield* Effect.forEach(
    jobs,
    Effect.fnUntraced(function* (job) {
      return { job, s: yield* seconds(job.started_at, job.completed_at) }
    })
  )
  const byDuration = timed.sort((a, b) => b.s - a.s)
  for (const { job, s } of byDuration)
    yield* Console.log(
      `| ${job.name} | ${s.toFixed(0)} | ${yield* slowestSteps(job)} |`
    )
})
