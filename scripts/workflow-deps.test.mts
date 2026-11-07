// A workflow job that runs a packages/deploy entry point imports its
// dependencies, so it has to install them first on a clean runner.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

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
})
