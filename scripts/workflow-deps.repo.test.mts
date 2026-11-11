// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner. CI runs the
// same checks as `pnpm check`, one root `check:*` script per job. e2e shards
// each Playwright project on its own, one matrix job per shard, and every
// shard runs on a cached browser and cached vite optimizer output and
// finishes whether or not the others fail. Each CI job installs through the
// install action, which restores node_modules.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"

const Manifest = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
)

const repoPath = (relPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.resolve(import.meta.dirname, "..", relPath)
  })

const repoFile = (relPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(yield* repoPath(relPath))
  })

// The lines under the first line equal to `header`, up to the next line
// indented no deeper than it.
const block = (text: string, header: string) => {
  const lines = text.split("\n")
  const start = lines.indexOf(header)
  if (start === -1) return []
  const depth = header.search(/\S/)
  const end = lines.findIndex(
    (line, index) =>
      index > start && /\S/.test(line) && line.search(/\S/) <= depth
  )
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

// The list items at `indent` in `lines`, each with the lines below it up to
// the next; lines before the first item are dropped.
const listItems = (lines: ReadonlyArray<string>, indent: number) => {
  const itemStart = new RegExp(`^ {${indent}}- `)
  const items: Array<string> = []
  for (const line of lines) {
    if (itemStart.test(line)) items.push(line)
    else if (items.length > 0) items[items.length - 1] += `\n${line}`
  }
  return items
}

const jobSteps = (workflow: string) =>
  Effect.sync(() => {
    const jobs = block(workflow, "jobs:").join("\n")
    const names = [...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map(
      ([, name]) => name as string
    )
    return new Map(
      names.map((name) => [name, listItems(block(jobs, `  ${name}:`), 6)])
    )
  })

// A composite action's steps.
const actionSteps = (action: string) =>
  Effect.sync(() => listItems(block(action, "  steps:"), 4))

const runsPnpmInstall = /\bpnpm install\b/
const usesInstallAction = /\buses: \.\/\.github\/actions\/install$/m

// A step that installs the workspace's dependencies, itself or through the
// install action.
const installsDeps = (step: string) =>
  runsPnpmInstall.test(step) || usesInstallAction.test(step)

const ciWorkflow = repoFile(".github/workflows/ci.yml")

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
          const jobs = yield* jobSteps(
            yield* repoFile(`.github/workflows/${file}`)
          )
          for (const [job, steps] of jobs) {
            const runs = steps.findIndex((step) =>
              /\bpackages\/deploy\/src\//.test(step)
            )
            if (runs === -1) continue
            checked++
            const installs = steps.findIndex(installsDeps)
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
      const { scripts } = yield* Schema.decodeEffect(Manifest)(
        yield* repoFile("package.json")
      )
      const jobs = yield* jobSteps(yield* ciWorkflow)
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
        const jobs = yield* jobSteps(yield* ciWorkflow)
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
    "e2e runs each Playwright project as its own shards, one per matrix job, and a failing shard stops no other",
    () =>
      Effect.gen(function* () {
        const config = yield* repoFile("apps/e2e/playwright.config.ts")
        const projects = [...config.matchAll(/^ {6}name: "([\w-]+)",$/gm)]
          .map(([, name]) => name as string)
          .filter((name) => name !== "setup")
        assert.isAbove(projects.length, 1, "found the specs' projects")
        const workflow = yield* ciWorkflow
        const e2e = block(workflow, "  e2e:").join("\n")
        const entries = [
          ...e2e.matchAll(
            /^ {10}- \{ project: ([\w-]+), shard: (\d+)\/(\d+) \}$/gm
          ),
        ].map(([, project, index, total]) => ({
          project: project as string,
          index: Number(index),
          total: Number(total),
        }))
        assert.match(e2e, /^ {6}matrix:\n {8}include:$/m)
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
            projectShards.map(({ index, total }) => `${index}/${total}`),
            projectShards.map(
              (_, index) => `${index + 1}/${projectShards.length}`
            ),
            `${project}'s shards are 1/n to n/n`
          )
        }
        assert.match(e2e, /^ {6}fail-fast: false$/m)
        const runs = (yield* jobSteps(workflow))
          .get("e2e")
          ?.filter((step) => /\bpnpm test:e2e\b/.test(step))
        assert.deepStrictEqual(
          runs?.map((step) =>
            step.includes(
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

  it.effect(
    "e2e restores both apps' vite optimizer output before the servers start, keyed by what invalidates it",
    () =>
      Effect.gen(function* () {
        const steps = (yield* jobSteps(yield* ciWorkflow)).get("e2e") ?? []
        const caches = steps.filter(
          (step) =>
            /\buses: actions\/cache@v\d+\b/.test(step) &&
            /\bnode_modules\/\.vite\b/.test(step)
        )
        assert.strictEqual(caches.length, 1, "one step caches vite's output")
        const cache = caches[0] ?? ""
        for (const app of ["web", "dashboard"]) {
          assert.match(
            cache,
            new RegExp(`^\\s+apps/${app}/node_modules/\\.vite$`, "m"),
            `${app}'s optimizer output is cached`
          )
        }
        const key = /^\s+key: (.+)$/m.exec(cache)?.[1] ?? ""
        for (const input of [
          "pnpm-lock.yaml",
          "apps/web/vite.config.ts",
          "apps/dashboard/vite.config.ts",
        ]) {
          assert.include(key, `'${input}'`, `the key hashes ${input}`)
        }
        const restoreKey = /^\s+restore-keys: (.+)$/m.exec(cache)?.[1] ?? ""
        assert.isTrue(
          restoreKey.length > 0 && key.startsWith(restoreKey),
          "a source change restores the last output for the same lockfile"
        )
        const installs = steps.findIndex(installsDeps)
        const runs = steps.findIndex((step) => /\bpnpm test:e2e\b/.test(step))
        assert.isAbove(steps.indexOf(cache), installs)
        assert.isBelow(steps.indexOf(cache), runs)
      })
  )

  it.effect(
    "every CI job installs through the install action before it runs pnpm, and none restores the pnpm store itself",
    () =>
      Effect.gen(function* () {
        const workflow = yield* ciWorkflow
        const jobs = yield* jobSteps(workflow)
        assert.isAbove(jobs.size, 0)
        const violations: Array<string> = []
        for (const [job, steps] of jobs) {
          const installs = steps.findIndex((step) =>
            usesInstallAction.test(step)
          )
          const firstPnpm = steps.findIndex((step) =>
            /^\s+(?:- )?run: .*\bpnpm\b/m.test(step)
          )
          if (installs === -1) violations.push(`${job}: no install action`)
          else if (firstPnpm !== -1 && firstPnpm < installs)
            violations.push(`${job}: runs pnpm before installing`)
          if (steps.some((step) => runsPnpmInstall.test(step)))
            violations.push(`${job}: runs pnpm install itself`)
          if (steps.some((step) => /^\s+cache: pnpm$/m.test(step)))
            violations.push(`${job}: setup-node restores the pnpm store`)
        }
        assert.deepStrictEqual(violations, [])
      })
  )

  it.effect(
    "the install action restores node_modules by the lockfile, and installs and saves them only on a miss",
    () =>
      Effect.gen(function* () {
        const steps = yield* actionSteps(
          yield* repoFile(".github/actions/install/action.yml")
        )
        const modulePaths = [
          "node_modules",
          "apps/*/node_modules",
          "packages/*/node_modules",
        ]
        const coversModules = (step: string) =>
          modulePaths.every((dir) =>
            new RegExp(`^\\s+${dir.replace(/[.*]/g, "\\$&")}$`, "m").test(step)
          )
        const restore = steps.findIndex(
          (step) =>
            /\buses: actions\/cache\/restore@v\d+\b/.test(step) &&
            coversModules(step)
        )
        assert.isAbove(restore, -1, "restores node_modules")
        const restoreStep = steps[restore] ?? ""
        const id = /^\s+(?:- )?id: ([\w-]+)$/m.exec(restoreStep)?.[1]
        assert.isDefined(id, "the restore step has an id")
        const key = /^\s+key: (.+)$/m.exec(restoreStep)?.[1] ?? ""
        assert.include(key, "hashFiles('pnpm-lock.yaml'")
        assert.include(key, "${{ runner.os }}")
        for (const tool of ["node", "pnpm"]) {
          const versionId = new RegExp(
            `\\$\\{\\{ steps\\.([\\w-]+)\\.outputs\\.${tool} \\}\\}`
          ).exec(key)?.[1]
          assert.isDefined(versionId, `the key names ${tool}'s version`)
          const reads = steps.findIndex((step) =>
            new RegExp(`^\\s+(?:- )?id: ${versionId}$`, "m").test(step)
          )
          assert.isAbove(reads, -1, `a step outputs ${tool}'s version`)
          assert.isBelow(reads, restore)
          assert.match(
            steps[reads] ?? "",
            new RegExp(`\\b${tool}=.*\\b${tool} (?:-p|--version)\\b`)
          )
        }
        const onMiss = `if: steps.${id}.outputs.cache-hit != 'true'`
        const installs = steps.filter((step) =>
          /\bpnpm install --frozen-lockfile\b/.test(step)
        )
        assert.strictEqual(installs.length, 1)
        const install = steps.indexOf(installs[0] ?? "")
        assert.include(installs[0], onMiss)
        const save = steps.findIndex(
          (step) =>
            /\buses: actions\/cache\/save@v\d+\b/.test(step) &&
            coversModules(step)
        )
        assert.isAbove(save, install, "saves node_modules after installing")
        assert.include(steps[save], onMiss)
        assert.include(
          steps[save],
          `key: \${{ steps.${id}.outputs.cache-primary-key }}`
        )
        const store = steps.findIndex(
          (step) =>
            /\buses: actions\/cache(?:\/restore)?@v\d+\b/.test(step) &&
            /^\s+key: pnpm-store-/m.test(step)
        )
        assert.isAbove(store, restore, "restores the pnpm store")
        assert.isBelow(store, install)
        assert.include(steps[store], onMiss)
      })
  )
})
