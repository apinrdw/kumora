// Where a CI run's time went: each job's seconds and its slowest steps, then,
// for each e2e job, when its first test finished and each spec's summed test
// time. `pnpm ci-timings <run-id>` (from `gh run list`) runs it. It finds the
// e2e jobs and their test step by the names .github/workflows/ci.yml gives
// them (`e2e`, `pnpm test:e2e`); ci.yml names this file back.
import { Console, Effect, Schedule, Schema } from "effect"

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

const seconds = (from: string | null, to: string | null) =>
  from === null || to === null ? 0 : (Date.parse(to) - Date.parse(from)) / 1000

// One finished Playwright test in a job log's list-reporter output, as
// "<timestamp> ✓  12 [chromium] › tests/x.spec.ts:9:3 › title (10.3s)".
const testLine =
  /^(\S+Z) \s*[✓✘-]\s+\d+\s+\[[\w-]+\]\s+›\s+(\S+?):\d+:\d+\s+›\s+.+\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/
const UNIT: Record<string, number> = { ms: 0.001, s: 1, m: 60 }

// An e2e job log's test count, seconds from the test step's start to its
// first finished test, and each spec's summed test seconds, slowest first.
export const specTimes = (log: string, testStepStart: string | null) => {
  const tests = log.split("\n").flatMap((line) => {
    const [, at = "", spec = "", value = "0", unit = "s"] =
      line.match(testLine) ?? []
    return spec === ""
      ? []
      : [{ at, spec, s: Number(value) * (UNIT[unit] ?? 1) }]
  })
  const specs = new Map<string, number>()
  for (const test of tests)
    specs.set(test.spec, (specs.get(test.spec) ?? 0) + test.s)
  return {
    tests: tests.length,
    firstTestAfter:
      tests[0] && testStepStart !== null
        ? seconds(testStepStart, tests[0].at)
        : undefined,
    specs: [...specs].sort((a, b) => b[1] - a[1]),
  }
}

const api = Effect.fn("api")(function* (root: string, path: string) {
  return yield* stdoutOf("gh", ["api", `repos/{owner}/{repo}/${path}`], {
    cwd: root,
  })
})

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))

const slowestSteps = (job: typeof Job.Type) =>
  job.steps
    .map((step) => ({
      name: step.name.replace(/^Run /, "").slice(0, 40),
      s: seconds(step.started_at, step.completed_at),
    }))
    .filter((step) => step.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((step) => `${step.name} ${step.s.toFixed(0)}`)
    .join("; ")

const e2eReport = Effect.fn("e2eReport")(function* (
  root: string,
  job: typeof Job.Type
) {
  // GitHub's log download redirects to blob storage, which sometimes times out.
  const log = yield* api(root, `actions/jobs/${job.id}/logs`).pipe(
    Effect.retry(Schedule.recurs(2))
  )
  const testStep = job.steps.find((step) => step.name.includes("test:e2e"))
  const { tests, firstTestAfter, specs } = specTimes(
    log,
    testStep?.started_at ?? null
  )
  yield* Console.log(
    `\n### ${job.name}\n\nFirst test finished ${firstTestAfter?.toFixed(0) ?? "?"} s into the test step; ${tests} tests.\n\n| spec | s |\n|---|---|`
  )
  for (const [spec, s] of specs)
    yield* Console.log(`| ${spec} | ${s.toFixed(1)} |`)
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
  const run = yield* decode(Run)(yield* api(root, `actions/runs/${runId}`))
  const { jobs } = yield* decode(Jobs)(
    yield* api(root, `actions/runs/${runId}/jobs?per_page=100`)
  )
  const end = jobs.map((job) => job.completed_at ?? job.started_at).sort()
  yield* Console.log(
    `Run ${runId} on ${run.head_sha.slice(0, 10)}: ${seconds(run.created_at, end.at(-1) ?? null).toFixed(0)} s from creation to the last job's end.\n\n| job | s | slowest steps (s) |\n|---|---|---|`
  )
  const duration = (job: typeof Job.Type) =>
    seconds(job.started_at, job.completed_at)
  const byDuration = [...jobs].sort((a, b) => duration(b) - duration(a))
  for (const job of byDuration)
    yield* Console.log(
      `| ${job.name} | ${duration(job).toFixed(0)} | ${slowestSteps(job)} |`
    )
  yield* Effect.forEach(
    byDuration.filter((job) => job.name.startsWith("e2e")),
    (job) => e2eReport(root, job),
    { discard: true }
  )
})
