// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `pnpm check`, one root `check:*` script per job. e2e runs as
// a matrix of shards that each finish on their own, on a cached browser.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)

const jobStart = /^ {2}([\w-]+):\s*$/
const stepStart = /^ {6}- /

const jobSteps = (workflow: string) =>
  Effect.sync(() => {
    const jobs = new Map<string, Array<string>>()
    let inJobs = false
    let steps: Array<string> | undefined
    for (const line of workflow.split("\n")) {
      if (/^\S/.test(line)) {
        inJobs = line.startsWith("jobs:")
        steps = undefined
        continue
      }
      const job = inJobs ? jobStart.exec(line) : null
      if (job !== null) {
        steps = []
        jobs.set(job[1] as string, steps)
      } else if (steps !== undefined && stepStart.test(line)) {
        steps.push(line)
      } else if (steps !== undefined && steps.length > 0) {
        steps[steps.length - 1] += `\n${line}`
      }
    }
    return jobs
  })

// A job's lines from its name up to the next job.
const jobText = (workflow: string, name: string) => {
  const lines = workflow.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ""
  const end = lines.findIndex(
    (line, index) => index > start && /^ {0,2}\S/.test(line)
  )
  return lines.slice(start, end === -1 ? undefined : end).join("\n")
}

const ciWorkflow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(
    path.resolve(import.meta.dirname, "../.github/workflows/ci.yml")
  )
})

layer(NodeServices.layer)("workflow dependencies", (it) => {
  it.effect(
    "every job running a packages/deploy entry point installs dependencies first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.resolve(import.meta.dirname, "../.github/workflows")
        const files = yield* fs.readDirectory(dir)
        let checked = 0
        const missing: Array<string> = []
        for (const file of files.filter((name) => name.endsWith(".yml"))) {
          const jobs = yield* jobSteps(
            yield* fs.readFileString(path.join(dir, file))
          )
          for (const [job, steps] of jobs) {
            const runs = steps.findIndex((step) =>
              /\bpackages\/deploy\/src\//.test(step)
            )
            if (runs === -1) continue
            checked++
            const installs = steps.findIndex((step) =>
              /\bpnpm install\b/.test(step)
            )
            if (installs === -1 || installs > runs) {
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
      const jobs = yield* jobSteps(
        yield* fs.readFileString(
          path.resolve(import.meta.dirname, "../.github/workflows/ci.yml")
        )
      )
      const perJob = [...jobs.values()]
        .map((steps) =>
          steps.flatMap((step) =>
            [...step.matchAll(/\bpnpm (check(?::[\w-]+)?)\b/g)].map(
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
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const jobs = yield* jobSteps(
          yield* fs.readFileString(
            path.resolve(import.meta.dirname, "../.github/workflows/ci.yml")
          )
        )
        let checked = 0
        const missing: Array<string> = []
        for (const [job, steps] of jobs) {
          const runs = steps.findIndex((step) =>
            /\bpnpm check(?::[\w-]+)?\b/.test(step)
          )
          if (runs === -1) continue
          checked++
          const caches = steps.findIndex((step) =>
            /\buses: rharkor\/caching-for-turbo@[0-9a-f]{40}\b/.test(step)
          )
          if (caches === -1 || caches > runs) missing.push(job)
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
        const e2e = jobText(workflow, "e2e")
        const shards = /^ {6}matrix:\n {8}shard: \[([\d, ]+)\]$/m.exec(e2e)
        assert.isNotNull(shards, "e2e has a shard matrix")
        const listed = (shards?.[1] ?? "").split(",").map(Number)
        assert.isAbove(listed.length, 1)
        assert.deepStrictEqual(
          listed,
          listed.map((_, index) => index + 1)
        )
        assert.match(e2e, /^ {6}fail-fast: false$/m)
        const runs = (yield* jobSteps(workflow))
          .get("e2e")
          ?.filter((step) => /\bpnpm test:e2e\b/.test(step))
        assert.deepStrictEqual(
          runs?.map((step) =>
            step.includes(
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
        const steps = (yield* jobSteps(yield* ciWorkflow)).get("e2e") ?? []
        const cache = steps.findIndex(
          (step) =>
            /\buses: actions\/cache@v\d+\b/.test(step) &&
            /^\s+path: ~\/\.cache\/ms-playwright$/m.test(step)
        )
        assert.isAbove(cache, -1, "e2e caches ~/.cache/ms-playwright")
        const cacheStep = steps[cache] ?? ""
        const cacheId = /^\s+(?:- )?id: ([\w-]+)$/m.exec(cacheStep)?.[1]
        const versionId = /\$\{\{ steps\.([\w-]+)\.outputs\.version \}\}/.exec(
          /^\s+key: (.+)$/m.exec(cacheStep)?.[1] ?? ""
        )?.[1]
        assert.isDefined(versionId, "the cache key names a step's version")
        const reads = steps.findIndex((step) =>
          new RegExp(`^\\s+(?:- )?id: ${versionId}$`, "m").test(step)
        )
        assert.isAbove(reads, -1, "a step outputs the version")
        assert.isBelow(reads, cache)
        assert.match(steps[reads] ?? "", /\bplaywright --version\b/)
        const installs = steps.filter((step) =>
          /\bplaywright install\b/.test(step)
        )
        assert.strictEqual(installs.length, 1)
        const install = installs[0] ?? ""
        assert.isAbove(steps.indexOf(install), cache)
        assert.include(
          install,
          `if: steps.${cacheId}.outputs.cache-hit != 'true'`
        )
        assert.match(install, /\bplaywright install chromium$/m)
        assert.notInclude(install, "--with-deps")
      })
  )
})
