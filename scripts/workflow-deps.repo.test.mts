// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `pnpm check`, one root `check:*` script per job. e2e runs as
// a matrix of shards that each finish on their own, on a cached browser.
// Workflows are read as YAML, so comments and layout never change a verdict.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "yaml"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)

const Step = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
type Step = typeof Step.Type

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optional(Schema.Array(Step)),
      strategy: Schema.optional(
        Schema.Struct({
          "fail-fast": Schema.optional(Schema.Boolean),
          matrix: Schema.optional(
            Schema.Struct({
              shard: Schema.optional(Schema.Array(Schema.Number)),
            })
          ),
        })
      ),
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

  it.effect(
    "e2e runs one shard per matrix job, and a failing shard stops no other",
    () =>
      Effect.gen(function* () {
        const workflow = yield* ciWorkflow
        const e2e = workflow.jobs["e2e"]
        const listed = e2e?.strategy?.matrix?.shard ?? []
        assert.isAbove(listed.length, 1, "e2e has a shard matrix")
        assert.deepStrictEqual(
          listed,
          listed.map((_, index) => index + 1)
        )
        assert.strictEqual(e2e?.strategy?.["fail-fast"], false)
        const tests = (e2e?.steps ?? []).filter((step) =>
          runs(step, /\bpnpm test:e2e\b/)
        )
        assert.deepStrictEqual(
          tests.map((step) =>
            (step.run ?? "").includes(
              "--shard=${{ matrix.shard }}/${{ strategy.job-total }}"
            )
          ),
          [true]
        )
      })
  )

  it.effect(
    "e2e restores the browser from a cache keyed by the Playwright version, and installs it only on a miss",
    () =>
      Effect.gen(function* () {
        const steps = jobSteps(yield* ciWorkflow).get("e2e") ?? []
        const cache = steps.findIndex(
          (step) =>
            /^actions\/cache@v\d+$/.test(step.uses ?? "") &&
            step.with?.["path"] === "~/.cache/ms-playwright"
        )
        assert.isAbove(cache, -1, "e2e caches ~/.cache/ms-playwright")
        const cacheStep = steps[cache]
        const cacheId = cacheStep?.id
        const versionId = /\$\{\{ steps\.([\w-]+)\.outputs\.version \}\}/.exec(
          String(cacheStep?.with?.["key"] ?? "")
        )?.[1]
        assert.isDefined(versionId, "the cache key names a step's version")
        const reads = steps.findIndex((step) => step.id === versionId)
        assert.isAbove(reads, -1, "a step outputs the version")
        assert.isBelow(reads, cache)
        assert.match(steps[reads]?.run ?? "", /\bplaywright --version\b/)
        const installs = steps.filter((step) =>
          runs(step, /\bplaywright install\b/)
        )
        assert.strictEqual(installs.length, 1)
        const install = installs[0]
        assert.isAbove(steps.indexOf(install as Step), cache)
        assert.strictEqual(
          install?.if,
          `steps.${cacheId}.outputs.cache-hit != 'true'`
        )
        assert.match(install?.run ?? "", /\bplaywright install chromium$/)
        assert.notInclude(install?.run ?? "", "--with-deps")
      })
  )
})
