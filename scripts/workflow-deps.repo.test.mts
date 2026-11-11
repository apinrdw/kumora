// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `pnpm check`, one root `check:*` script per job. e2e shards
// each Playwright project on its own, one matrix job per shard, and every
// shard runs on a cached browser and cached vite optimizer output and
// finishes whether or not the others fail. Each CI job installs through the
// install action, which restores node_modules. Workflows and the action are
// read as YAML, so comments and layout never change a verdict.
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
              include: Schema.optional(
                Schema.Array(
                  Schema.Struct({
                    project: Schema.String,
                    shard: Schema.String,
                  })
                )
              ),
            })
          ),
        })
      ),
    })
  ),
})

const Action = Schema.Struct({
  runs: Schema.Struct({ steps: Schema.Array(Step) }),
})

const repoPath = (relPath: string) =>
  Effect.map(Path.Path, (path) =>
    path.resolve(import.meta.dirname, "..", relPath)
  )

const repoFile = Effect.fn("repoFile")(function* (relPath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(yield* repoPath(relPath))
})

const readWorkflow = Effect.fn("readWorkflow")(function* (relPath: string) {
  return yield* Schema.decodeUnknownEffect(Workflow)(
    parse(yield* repoFile(relPath))
  )
})

const ciWorkflow = readWorkflow(".github/workflows/ci.yml")

const installAction = Effect.flatMap(
  repoFile(".github/actions/install/action.yml"),
  (text) => Schema.decodeUnknownEffect(Action)(parse(text))
)

// Each job's steps, by job name.
const jobSteps = (workflow: typeof Workflow.Type) =>
  new Map(
    Object.entries(workflow.jobs).map(([name, job]) => [name, job.steps ?? []])
  )

const runs = (step: Step, pattern: RegExp) => pattern.test(step.run ?? "")

const input = (step: Step, name: string) => String(step.with?.[name] ?? "")

const usesCache = (step: Step, kind: "" | "/restore" | "/save") =>
  new RegExp(`^actions/cache${kind}@v\\d+$`).test(step.uses ?? "")

const usesInstallAction = (step: Step) =>
  step.uses === "./.github/actions/install"

// A step that installs the workspace's dependencies, itself or through the
// install action.
const installsDeps = (step: Step) =>
  runs(step, /\bpnpm install\b/) || usesInstallAction(step)

// The index of the step whose id is the one `expression` reads an output of.
const outputStep = (
  steps: ReadonlyArray<Step>,
  expression: string,
  output: string
) => {
  const id = new RegExp(
    `\\$\\{\\{ steps\\.([\\w-]+)\\.outputs\\.${output} \\}\\}`
  ).exec(expression)?.[1]
  return id === undefined ? -1 : steps.findIndex((step) => step.id === id)
}

layer(NodeServices.layer)("workflow dependencies", (it) => {
  it.effect(
    "every job running a packages/deploy entry point installs dependencies first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const files = yield* fs.readDirectory(
          yield* repoPath(".github/workflows")
        )
        let checked = 0
        const missing: Array<string> = []
        for (const file of files.filter((name) => name.endsWith(".yml"))) {
          const jobs = jobSteps(
            yield* readWorkflow(`.github/workflows/${file}`)
          )
          for (const [job, steps] of jobs) {
            const deploy = steps.findIndex((step) =>
              runs(step, /\bpackages\/deploy\/src\//)
            )
            if (deploy === -1) continue
            checked++
            const installs = steps.findIndex(installsDeps)
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
      const { scripts } = yield* Schema.decodeEffect(Manifest)(
        yield* repoFile("package.json")
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
    "e2e runs each Playwright project as its own shards, one per matrix job, and a failing shard stops no other",
    () =>
      Effect.gen(function* () {
        const config = yield* repoFile("apps/e2e/playwright.config.ts")
        const projects = [...config.matchAll(/^ {6}name: "([\w-]+)",$/gm)]
          .map(([, name]) => name as string)
          .filter((name) => name !== "setup")
        assert.isAbove(projects.length, 1, "found the specs' projects")
        const e2e = (yield* ciWorkflow).jobs["e2e"]
        const entries = e2e?.strategy?.matrix?.include ?? []
        assert.deepStrictEqual(
          [...new Set(entries.map(({ project }) => project))].sort(),
          [...projects].sort()
        )
        for (const project of projects) {
          const projectShards = entries.filter(
            (entry) => entry.project === project
          )
          assert.isAbove(projectShards.length, 1, `${project} runs as shards`)
          assert.deepStrictEqual(
            projectShards.map(({ shard }) => shard),
            projectShards.map(
              (_, index) => `${index + 1}/${projectShards.length}`
            ),
            `${project}'s shards are 1/n to n/n`
          )
        }
        assert.strictEqual(e2e?.strategy?.["fail-fast"], false)
        const tests = (e2e?.steps ?? []).filter((step) =>
          runs(step, /\bpnpm test:e2e\b/)
        )
        assert.deepStrictEqual(
          tests.map((step) =>
            (step.run ?? "").includes(
              "--project=${{ matrix.project }} --shard=${{ matrix.shard }}"
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
            usesCache(step, "") &&
            input(step, "path") === "~/.cache/ms-playwright"
        )
        const cacheStep = steps[cache]
        assert.isDefined(cacheStep, "e2e caches ~/.cache/ms-playwright")
        const reads = outputStep(steps, input(cacheStep, "key"), "version")
        const versionStep = steps[reads]
        assert.isDefined(versionStep, "the cache key names a step's version")
        assert.isBelow(reads, cache, "the version step runs before the cache")
        assert.isTrue(
          runs(versionStep, /\bplaywright --version\b/),
          "the version step runs playwright --version"
        )
        const installs = steps.filter((step) =>
          runs(step, /\bplaywright install\b/)
        )
        const [install] = installs
        assert.isDefined(install, "e2e installs the browser")
        assert.strictEqual(installs.length, 1, "e2e installs the browser once")
        assert.isAbove(
          steps.indexOf(install),
          cache,
          "the install step runs after the cache"
        )
        assert.strictEqual(
          install.if,
          `steps.${cacheStep.id}.outputs.cache-hit != 'true'`,
          "the install step's if: runs it only on a cache miss"
        )
        assert.isTrue(
          runs(install, /\bplaywright install chromium$/),
          "the install step runs playwright install chromium"
        )
        assert.isFalse(
          runs(install, /--with-deps/),
          "the install step skips --with-deps"
        )
      })
  )

  it.effect(
    "e2e restores both apps' vite optimizer output before the servers start, keyed by what invalidates it",
    () =>
      Effect.gen(function* () {
        const steps = jobSteps(yield* ciWorkflow).get("e2e") ?? []
        const caches = steps.filter(
          (step) =>
            usesCache(step, "") &&
            /\bnode_modules\/\.vite\b/.test(input(step, "path"))
        )
        const [cache] = caches
        assert.isDefined(cache, "a step caches vite's output")
        assert.strictEqual(caches.length, 1, "one step caches vite's output")
        const paths = input(cache, "path").trim().split("\n")
        for (const app of ["web", "dashboard"]) {
          assert.include(
            paths,
            `apps/${app}/node_modules/.vite`,
            `${app}'s optimizer output is cached`
          )
        }
        const key = input(cache, "key")
        for (const file of [
          "pnpm-lock.yaml",
          "apps/web/vite.config.ts",
          "apps/dashboard/vite.config.ts",
        ]) {
          assert.include(key, `'${file}'`, `the key hashes ${file}`)
        }
        const restoreKey = input(cache, "restore-keys")
        assert.isTrue(
          restoreKey.length > 0 && key.startsWith(restoreKey),
          "a source change restores the last output for the same lockfile"
        )
        const installs = steps.findIndex(installsDeps)
        const tests = steps.findIndex((step) => runs(step, /\bpnpm test:e2e\b/))
        assert.isAbove(steps.indexOf(cache), installs)
        assert.isBelow(steps.indexOf(cache), tests)
      })
  )

  it.effect(
    "every CI job installs through the install action before it runs pnpm, and none restores the pnpm store itself",
    () =>
      Effect.gen(function* () {
        const jobs = jobSteps(yield* ciWorkflow)
        assert.isAbove(jobs.size, 0)
        const violations: Array<string> = []
        for (const [job, steps] of jobs) {
          const installs = steps.findIndex(usesInstallAction)
          const firstPnpm = steps.findIndex((step) => runs(step, /\bpnpm\b/))
          if (installs === -1) violations.push(`${job}: no install action`)
          else if (firstPnpm !== -1 && firstPnpm < installs)
            violations.push(`${job}: runs pnpm before installing`)
          if (steps.some((step) => runs(step, /\bpnpm install\b/)))
            violations.push(`${job}: runs pnpm install itself`)
          if (steps.some((step) => step.with?.["cache"] === "pnpm"))
            violations.push(`${job}: setup-node restores the pnpm store`)
        }
        assert.deepStrictEqual(violations, [])
      })
  )

  it.effect(
    "the install action restores node_modules by the lockfile, Node and pnpm, and installs and saves them only on a miss",
    () =>
      Effect.gen(function* () {
        const { steps } = (yield* installAction).runs
        const modulePaths = [
          "node_modules",
          "apps/*/node_modules",
          "packages/*/node_modules",
        ]
        const coversModules = (step: Step) => {
          const paths = input(step, "path").trim().split("\n")
          return modulePaths.every((dir) => paths.includes(dir))
        }
        const restore = steps.findIndex(
          (step) => usesCache(step, "/restore") && coversModules(step)
        )
        const restoreStep = steps[restore]
        assert.isDefined(restoreStep, "restores node_modules")
        assert.isDefined(restoreStep.id, "the restore step has an id")
        const key = input(restoreStep, "key")
        assert.include(key, "hashFiles('pnpm-lock.yaml'")
        assert.include(key, "${{ runner.os }}")
        for (const tool of ["node", "pnpm"]) {
          const reads = outputStep(steps, key, tool)
          const versionStep = steps[reads]
          assert.isDefined(versionStep, `the key names ${tool}'s version`)
          assert.isBelow(reads, restore)
          assert.isTrue(
            runs(
              versionStep,
              new RegExp(`\\b${tool}=.*\\b${tool} (?:-p|--version)\\b`)
            ),
            `the version step reads ${tool}'s version`
          )
        }
        const onMiss = `steps.${restoreStep.id}.outputs.cache-hit != 'true'`
        const installs = steps.filter((step) =>
          runs(step, /\bpnpm install --frozen-lockfile\b/)
        )
        const [install] = installs
        assert.isDefined(install, "the action installs")
        assert.strictEqual(installs.length, 1, "the action installs once")
        assert.strictEqual(install.if, onMiss)
        const save = steps.findIndex(
          (step) => usesCache(step, "/save") && coversModules(step)
        )
        assert.isAbove(
          save,
          steps.indexOf(install),
          "saves node_modules after installing"
        )
        assert.strictEqual(steps[save]?.if, onMiss)
        assert.strictEqual(
          input(steps[save] ?? {}, "key"),
          `\${{ steps.${restoreStep.id}.outputs.cache-primary-key }}`
        )
        const store = steps.findIndex(
          (step) =>
            (usesCache(step, "") || usesCache(step, "/restore")) &&
            input(step, "key").startsWith("pnpm-store-")
        )
        assert.isAbove(store, restore, "restores the pnpm store")
        assert.isBelow(store, steps.indexOf(install))
        assert.strictEqual(steps[store]?.if, onMiss)
      })
  )
})
