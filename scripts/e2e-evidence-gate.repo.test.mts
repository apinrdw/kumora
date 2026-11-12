// The e2e-evidence gate: a cheap job that marks each PR head commit's
// `e2e-evidence` status red until the local evidence command sets it green, or
// green when the PR needs no evidence (apinrdw/kumora#203). The shape tests
// read the workflow as YAML; the behaviour tests run its github-script against
// a fake GitHub client and read the status it writes.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "yaml"

const Workflow = Schema.Struct({
  on: Schema.Record(
    Schema.String,
    Schema.Struct({ types: Schema.Array(Schema.String) })
  ),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.optional(Schema.String),
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.Array(
        Schema.Struct({
          uses: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
          with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        })
      ),
    })
  ),
})

const gateWorkflow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* Schema.decodeUnknownEffect(Workflow)(
    parse(
      yield* fs.readFileString(
        path.resolve(
          import.meta.dirname,
          "../.github/workflows/e2e-evidence.yml"
        )
      )
    )
  )
})

const gateJob = Effect.flatMap(gateWorkflow, (workflow) => {
  const job = workflow.jobs["e2e-evidence"]
  return job === undefined
    ? Effect.die(new Error("e2e-evidence.yml has no e2e-evidence job"))
    : Effect.succeed(job)
})

interface Status {
  readonly context: string
  readonly state: string
  readonly creator: { readonly login: string }
}

interface Written {
  readonly sha: string
  readonly state: string
  readonly description: string
}

interface Pr {
  // Newest first, as the GitHub API lists them.
  readonly statuses?: ReadonlyArray<Status>
  readonly files: ReadonlyArray<{
    readonly filename: string
    readonly previous_filename?: string
  }>
  readonly labels?: ReadonlyArray<string>
}

const sha = "abc1234def5678abc1234def5678abc1234def56"
const author = { login: "apinrdw" }
const gate = { login: "github-actions[bot]" }

const gateScript = Effect.map(gateJob, (job) =>
  String(job.steps[0]?.with?.["script"])
)

// Runs the job's script as actions/github-script does, as the body of an async
// function given `github` and `context`, and returns the statuses it wrote.
const runGate = (pr: Pr) =>
  Effect.gen(function* () {
    const script = yield* gateScript
    const written: Array<Written> = []
    // The script awaits each call, so the fakes answer with plain values.
    const github = {
      paginate: (method: (params: unknown) => unknown, params: unknown) =>
        method(params),
      rest: {
        repos: {
          listCommitStatusesForRef: () => pr.statuses ?? [],
          createCommitStatus: (status: Written & { context: string }) => {
            assert.strictEqual(status.context, "e2e-evidence")
            written.push({
              sha: status.sha,
              state: status.state,
              description: status.description,
            })
          },
        },
        pulls: { listFiles: () => pr.files },
      },
    }
    const context = {
      repo: { owner: "apinrdw", repo: "kumora" },
      payload: {
        pull_request: {
          number: 7,
          head: { sha },
          labels: (pr.labels ?? []).map((name) => ({ name })),
        },
      },
    }
    // github-script wraps the script as `(async () => { <script> })()`.
    const runScript = new Function(
      "github",
      "context",
      `return (async () => {\n${script}\n})()`
    ) as (github: unknown, context: unknown) => Promise<unknown>
    yield* Effect.promise(() => runScript(github, context))
    return written
  })

const appFile = { filename: "apps/web/src/routes/index.tsx" }
const docsFile = { filename: "docs/runbooks/deploy.md" }

layer(NodeServices.layer)("e2e-evidence gate", (it) => {
  it.effect(
    "runs on pull_request_target alone, whose token can write the status on a Dependabot or fork PR",
    () =>
      Effect.gen(function* () {
        const workflow = yield* gateWorkflow
        assert.deepStrictEqual(Object.keys(workflow.on), [
          "pull_request_target",
        ])
      })
  )

  it.effect("runs on the five types that change the head or its labels", () =>
    Effect.gen(function* () {
      const workflow = yield* gateWorkflow
      assert.deepStrictEqual(
        Object.values(workflow.on).map((trigger) => [...trigger.types].sort()),
        [["labeled", "opened", "reopened", "synchronize", "unlabeled"]]
      )
    })
  )

  it.effect(
    "is the workflow's only job and one github-script step, so no checkout, install or run step executes PR code",
    () =>
      Effect.gen(function* () {
        const workflow = yield* gateWorkflow
        assert.deepStrictEqual(Object.keys(workflow.jobs), ["e2e-evidence"])
        const job = yield* gateJob
        assert.deepStrictEqual(
          job.steps.map((step) => [
            /^actions\/github-script@v\d+$/.test(step.uses ?? ""),
            step.run,
          ]),
          [[true, undefined]]
        )
      })
  )

  it.effect(
    "interpolates nothing into its script, so no string a PR controls becomes code",
    () =>
      Effect.gen(function* () {
        assert.notInclude(yield* gateScript, "${{")
      })
  )

  it.effect(
    "holds only the two permissions it uses: write statuses, read the PR",
    () =>
      Effect.gen(function* () {
        const job = yield* gateJob
        assert.deepStrictEqual(job.permissions, {
          statuses: "write",
          "pull-requests": "read",
        })
      })
  )

  it.effect(
    "names its check run apart from the e2e-evidence status, so a green job never stands in for the status",
    () =>
      Effect.gen(function* () {
        const job = yield* gateJob
        assert.isDefined(job.name)
        assert.notStrictEqual(job.name, "e2e-evidence")
      })
  )

  it.effect("marks an app PR's head red", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* runGate({ files: [docsFile, appFile] }), [
        { sha, state: "failure", description: "no e2e evidence for abc1234" },
      ])
    })
  )

  it.effect.each([
    "apps/web/a.ts",
    "apps/dashboard/a.ts",
    "apps/extension/a.ts",
    "apps/e2e/tests/a.spec.ts",
    "packages/server/src/a.ts",
  ])("counts %s as app code", (filename) =>
    Effect.gen(function* () {
      const [status] = yield* runGate({ files: [{ filename }] })
      assert.strictEqual(status?.state, "failure")
    })
  )

  it.effect("counts a file renamed out of app code as app code", () =>
    Effect.gen(function* () {
      const [status] = yield* runGate({
        files: [
          { filename: "docs/old.ts", previous_filename: "apps/web/old.ts" },
        ],
      })
      assert.strictEqual(status?.state, "failure")
    })
  )

  it.effect("passes a PR that touches no app code, and says why", () =>
    Effect.gen(function* () {
      const written = yield* runGate({
        files: [docsFile, { filename: "apps/webhooks/a.ts" }],
      })
      assert.strictEqual(written.length, 1)
      assert.strictEqual(written[0]?.state, "success")
      assert.match(written[0]?.description ?? "", /no app code/)
    })
  )

  it.effect("passes an app PR labelled no-e2e-evidence, and says why", () =>
    Effect.gen(function* () {
      const written = yield* runGate({
        files: [appFile],
        labels: ["in-progress", "no-e2e-evidence"],
      })
      assert.strictEqual(written.length, 1)
      assert.strictEqual(written[0]?.state, "success")
      assert.match(written[0]?.description ?? "", /no-e2e-evidence label/)
    })
  )

  it.effect("leaves posted evidence's success alone", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* runGate({
          files: [appFile],
          statuses: [
            { context: "e2e-evidence", state: "success", creator: author },
            { context: "e2e-evidence", state: "failure", creator: gate },
          ],
        }),
        []
      )
    })
  )

  it.effect(
    "turns its own opt-out success red again once the label is removed",
    () =>
      Effect.gen(function* () {
        const [status] = yield* runGate({
          files: [appFile],
          statuses: [
            { context: "e2e-evidence", state: "success", creator: gate },
          ],
        })
        assert.strictEqual(status?.state, "failure")
      })
  )

  it.effect("reads only the latest e2e-evidence status", () =>
    Effect.gen(function* () {
      const [status] = yield* runGate({
        files: [appFile],
        statuses: [
          { context: "static", state: "success", creator: author },
          { context: "e2e-evidence", state: "failure", creator: author },
          { context: "e2e-evidence", state: "success", creator: author },
        ],
      })
      assert.strictEqual(status?.state, "failure")
    })
  )
})
