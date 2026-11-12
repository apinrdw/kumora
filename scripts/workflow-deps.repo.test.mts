// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `pnpm check`, one root `check:*` script per job. No job runs
// e2e: a PR carries locally recorded evidence instead.
// Workflows are read as YAML, so comments and layout never change a verdict.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "yaml"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)

const Step = Schema.Struct({
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
})
type Step = typeof Step.Type

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optional(Schema.Array(Step)),
    })
  ),
})

const readWorkflow = Effect.fn("readWorkflow")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* Schema.decodeUnknownEffect(Workflow)(
    parse(yield* fs.readFileString(file))
  )
})

const workflowsDir = Effect.map(Path.Path, (path) =>
  path.resolve(import.meta.dirname, "../.github/workflows")
)

const ciWorkflow = Effect.flatMap(workflowsDir, (dir) =>
  readWorkflow(`${dir}/ci.yml`)
)

// Each job's steps, by job name.
const jobSteps = (workflow: typeof Workflow.Type) =>
  new Map(
    Object.entries(workflow.jobs).map(([name, job]) => [name, job.steps ?? []])
  )

const runs = (step: Step, pattern: RegExp) => pattern.test(step.run ?? "")

layer(NodeServices.layer)("workflow dependencies", (it) => {
  it.effect(
    "every job running a packages/deploy entry point installs dependencies first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* workflowsDir
        const files = yield* fs.readDirectory(dir)
        let checked = 0
        const missing: Array<string> = []
        for (const file of files.filter((name) => name.endsWith(".yml"))) {
          const jobs = jobSteps(yield* readWorkflow(`${dir}/${file}`))
          for (const [job, steps] of jobs) {
            const deploy = steps.findIndex((step) =>
              runs(step, /\bpackages\/deploy\/src\//)
            )
            if (deploy === -1) continue
            checked++
            const installs = steps.findIndex((step) =>
              runs(step, /\bpnpm install\b/)
            )
            if (installs === -1 || installs > deploy) {
              missing.push(`${file} ${job}`)
            }
          }
        }
        assert.isAbove(checked, 0, "found a job running packages/deploy")
        assert.deepStrictEqual(missing, [])
      })
  )

  it.effect("CI runs each root check:* script in a job of its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { scripts } = yield* Schema.decodeEffect(Manifest)(
        yield* fs.readFileString(
          path.resolve(import.meta.dirname, "../package.json")
        )
      )
      const perJob = [...jobSteps(yield* ciWorkflow).values()]
        .map((steps) =>
          steps.flatMap((step) =>
            [...(step.run ?? "").matchAll(/\bpnpm (check(?::[\w-]+)?)\b/g)].map(
              ([, script]) => script as string
            )
          )
        )
        .filter((checks) => checks.length > 0)
      const parts = Object.keys(scripts).filter((name) =>
        name.startsWith("check:")
      )
      assert.isAbove(parts.length, 0, "found a root check:* script")
      assert.deepStrictEqual(
        perJob.map((checks) => checks.join(", ")).sort(),
        parts.sort()
      )
    })
  )

  it.effect(
    "each CI job running a check:* script starts the turbo cache, pinned to a commit, first",
    () =>
      Effect.gen(function* () {
        let checked = 0
        const missing: Array<string> = []
        for (const [job, steps] of jobSteps(yield* ciWorkflow)) {
          const check = steps.findIndex((step) =>
            runs(step, /\bpnpm check(?::[\w-]+)?\b/)
          )
          if (check === -1) continue
          checked++
          const caches = steps.findIndex((step) =>
            /^rharkor\/caching-for-turbo@[0-9a-f]{40}$/.test(step.uses ?? "")
          )
          if (caches === -1 || caches > check) missing.push(job)
        }
        assert.isAbove(checked, 0, "found a job running a check:* script")
        assert.deepStrictEqual(missing, [])
      })
  )

  it.effect("no workflow job runs pnpm test:e2e", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* workflowsDir
      const files = yield* fs.readDirectory(dir)
      const e2e: Array<string> = []
      for (const file of files.filter((name) => name.endsWith(".yml"))) {
        for (const [job, steps] of jobSteps(
          yield* readWorkflow(`${dir}/${file}`)
        )) {
          if (steps.some((step) => runs(step, /\bpnpm test:e2e\b/)))
            e2e.push(`${file} ${job}`)
        }
      }
      assert.deepStrictEqual(e2e, [])
    })
  )
})
