// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `vp run check`, one root `check:*` script per job. Only
// e2e.yml's suite jobs run e2e, on the free runner, behind one required `e2e`
// job.
// Workflows are read as YAML, so comments and layout never change a verdict.
// Decision: e2e runs on GitHub's free runners; local evidence is video only
// (docs/adr/0024-e2e-runs-on-github-s-free-runners-and-local-evidence-is-video-only.md)
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { parse } from "yaml"

import { collect } from "./lib/command.mts"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)

const Step = Schema.Struct({
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
type Step = typeof Step.Type

const Job = Schema.Struct({
  name: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  needs: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)])
  ),
  "runs-on": Schema.optional(Schema.String),
  strategy: Schema.optional(
    Schema.Struct({
      matrix: Schema.Struct({
        include: Schema.optional(
          Schema.Array(Schema.Struct({ projects: Schema.String }))
        ),
      }),
    })
  ),
  steps: Schema.optional(Schema.Array(Step)),
})

const Workflow = Schema.Struct({
  jobs: Schema.Record(Schema.String, Job),
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

const e2eWorkflow = Effect.flatMap(workflowsDir, (dir) =>
  readWorkflow(`${dir}/e2e.yml`)
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
              runs(step, /\bvp install\b/)
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
            [
              ...(step.run ?? "").matchAll(/\bvp run (check(?::[\w-]+)?)\b/g),
            ].map(([, script]) => script as string)
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
            runs(step, /\bvp run check(?::[\w-]+)?\b/)
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

  it.effect(
    "only e2e.yml's suite job runs test:e2e, on the free runner, by project",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* workflowsDir
        const files = yield* fs.readDirectory(dir)
        const e2e: Array<string> = []
        for (const file of files.filter((name) => name.endsWith(".yml"))) {
          for (const [job, steps] of jobSteps(
            yield* readWorkflow(`${dir}/${file}`)
          )) {
            if (steps.some((step) => runs(step, /\btest:e2e\b/)))
              e2e.push(`${file} ${job}`)
          }
        }
        assert.deepStrictEqual(e2e, ["e2e.yml suite"])
        const { suite } = (yield* e2eWorkflow).jobs
        // A larger runner bills by the minute even on a public repo.
        assert.strictEqual(suite?.["runs-on"], "ubuntu-latest")
        const step = suite?.steps?.find((one) => runs(one, /\btest:e2e\b/))
        assert.include(step?.run, "--forbid-only")
        assert.strictEqual(
          step?.env?.["E2E_PROJECTS"],
          "${{ matrix.projects }}"
        )
      })
  )

  it.effect("e2e.yml's matrix runs every Playwright project but setup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* fs.readFileString(
        path.resolve(import.meta.dirname, "../apps/e2e/playwright.config.ts")
      )
      // chromium-video exists only on an evidence run, which CI never is.
      const projects = [...config.matchAll(/^\s*name: "([\w-]+)",$/gm)]
        .map(([, name]) => name as string)
        .filter((name) => name !== "setup" && name !== "chromium-video")
      assert.isAbove(projects.length, 0, "found the config's projects")
      const matrix = (yield* e2eWorkflow).jobs.suite?.strategy?.matrix.include
      assert.deepStrictEqual(
        [...new Set(matrix?.map((job) => job.projects))].sort(),
        projects.sort()
      )
    })
  )

  it.effect(
    "the required e2e job always runs and waits on every other job",
    () =>
      Effect.gen(function* () {
        const { jobs } = yield* e2eWorkflow
        const { e2e } = jobs
        assert.strictEqual(e2e?.name, "e2e")
        assert.match(e2e?.if ?? "", /^always\(\) && /)
        assert.deepStrictEqual(
          [e2e?.needs ?? []].flat().sort(),
          Object.keys(jobs)
            .filter((job) => job !== "e2e")
            .sort()
        )
      })
  )

  it.effect(
    "the e2e job passes with no app code or every suite job green, and fails otherwise",
    () =>
      Effect.gen(function* () {
        const script = (yield* e2eWorkflow).jobs.e2e?.steps?.[0]?.run ?? ""
        const verdict = (env: Record<string, string>) =>
          Effect.map(
            collect(ChildProcess.make("bash", ["-c", script], { env })),
            ({ exitCode }) => (exitCode === 0 ? "pass" : "fail")
          )
        // When the changes job finds no app code, the suite jobs skip.
        const cases = [
          [{ CHANGES: "success", APP: "false", SUITE: "skipped" }, "pass"],
          [{ CHANGES: "success", APP: "true", SUITE: "success" }, "pass"],
          [{ CHANGES: "success", APP: "true", SUITE: "failure" }, "fail"],
          [{ CHANGES: "success", APP: "true", SUITE: "cancelled" }, "fail"],
          [{ CHANGES: "success", APP: "true", SUITE: "skipped" }, "fail"],
          [{ CHANGES: "failure", APP: "", SUITE: "skipped" }, "fail"],
          [{ CHANGES: "cancelled", APP: "", SUITE: "skipped" }, "fail"],
        ] as const
        assert.deepStrictEqual(
          yield* Effect.forEach(cases, ([env]) => verdict(env)),
          cases.map(([, expected]) => expected)
        )
      })
  )

  it.effect(
    "each job that calls vp or pnpm sets up vp first, by setup-vp pinned to a commit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* workflowsDir
        const files = yield* fs.readDirectory(dir)
        let checked = 0
        const missing: Array<string> = []
        for (const file of files.filter((name) => name.endsWith(".yml"))) {
          for (const [job, steps] of jobSteps(
            yield* readWorkflow(`${dir}/${file}`)
          )) {
            const calls = steps.findIndex((step) =>
              runs(step, /^\s*(?:vp|pnpm)\s/m)
            )
            if (calls === -1) continue
            checked++
            const setup = steps.findIndex((step) =>
              /^voidzero-dev\/setup-vp@[0-9a-f]{40}$/.test(step.uses ?? "")
            )
            const pnpmSetup = steps.some((step) =>
              /^(?:pnpm\/action-setup|actions\/setup-node)@/.test(
                step.uses ?? ""
              )
            )
            if (setup === -1 || setup > calls || pnpmSetup)
              missing.push(`${file} ${job}`)
          }
        }
        assert.isAbove(checked, 0, "found a job calling vp")
        assert.deepStrictEqual(missing, [])
      })
  )
})
