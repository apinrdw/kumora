// Fails when a place that installs vp names a version other than the root
// `vite-plus` devDependency, so a vite-plus bump can't leave CI on an older vp.
// That is each workflow's setup-vp step; Workers Builds installs no vp.
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "yaml"

import { CheckFailed } from "./lib/check.mts"

// Decision: vp is the CLI; pnpm resolves underneath; turbo still runs the tasks
// (docs/adr/0021-vp-is-the-cli-pnpm-resolves-underneath-turbo-still-runs-the-tasks.md)
const setupVp = /^voidzero-dev\/setup-vp@/
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    devDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.String)
    ),
  })
)

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optional(
        Schema.Array(
          Schema.Struct({
            uses: Schema.optional(Schema.String),
            with: Schema.optional(
              Schema.Struct({
                version: Schema.optional(
                  Schema.Union([Schema.String, Schema.Number])
                ),
              })
            ),
          })
        )
      ),
    })
  ),
})

// One place that installs vp: where it is, and the version it names.
interface Install {
  readonly site: string
  readonly version: string | undefined
}

const setupVpSteps = Effect.fn("setupVpSteps")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = ".github/workflows"
  const files = (yield* fs.readDirectory(path.join(root, dir)))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
  return yield* Effect.forEach(files, (file) =>
    fs.readFileString(path.join(root, dir, file)).pipe(
      Effect.flatMap((text) =>
        Schema.decodeUnknownEffect(Workflow)(parse(text))
      ),
      Effect.map(({ jobs }) =>
        Object.entries(jobs).flatMap(([job, { steps = [] }]) =>
          steps
            .filter((step) => setupVp.test(step.uses ?? ""))
            .map((step): Install => ({
              site: `${dir}/${file} ${job}`,
              version:
                step.with?.version === undefined
                  ? undefined
                  : String(step.with.version),
            }))
        )
      )
    )
  ).pipe(Effect.map((perFile) => perFile.flat()))
})

export const checkVpVersion = Effect.fn("checkVpVersion")(function* (
  root: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { devDependencies = {} } = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(root, "package.json"))
  )
  const pin = devDependencies["vite-plus"]
  if (pin === undefined || !exactVersion.test(pin))
    return yield* new CheckFailed({
      summary: `package.json needs an exact vite-plus devDependency, such as "1.8.0", for vp's version to follow. It has:`,
      findings: [pin ?? "none"],
    })
  const installs = yield* setupVpSteps(root)
  if (installs.length === 0)
    return yield* new CheckFailed({
      summary:
        "No workflow step uses setup-vp, so this check reads no vp version. Point it at the step that installs vp now:",
      findings: [".github/workflows"],
    })
  const drifted = installs.filter(({ version }) => version !== pin)
  if (drifted.length > 0)
    return yield* new CheckFailed({
      summary: `Each setup-vp step's version must equal the root vite-plus devDependency (${pin}). Differs:`,
      findings: drifted.map(
        ({ site, version }) => `${site}: ${version ?? "no version"}`
      ),
    })
  yield* Console.log(
    `vp ${pin} in package.json and ${installs.length} setup-vp steps.`
  )
})
