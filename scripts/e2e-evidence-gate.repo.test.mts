// The e2e-evidence gate: a cheap job that marks each PR head commit's
// `e2e-evidence` status red until the local evidence command sets it green, or
// green when the PR needs no evidence (apinrdw/kumora#203). The shape tests
// read the workflow as YAML; the behaviour tests run its github-script against
// a fake GitHub client and read the status it writes.
import { data, Evaluator, Lexer, Parser } from "@actions/expressions"
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { parse } from "yaml"

const Workflow = Schema.Struct({
  on: Schema.Record(
    Schema.String,
    Schema.Struct({ types: Schema.Array(Schema.String) })
  ),
  concurrency: Schema.Struct({
    group: Schema.String,
    "cancel-in-progress": Schema.Union([Schema.Boolean, Schema.String]),
  }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.optional(Schema.String),
      if: Schema.optional(Schema.String),
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
// The login of every workflow's GITHUB_TOKEN, whatever event triggered it.
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

// A retarget is the one `edited` event that carries `changes.base`.
const notATitleOrBodyEdit =
  "github.event.action != 'edited' || github.event.changes.base.ref.from != ''"

// One pull_request_target event, as the `github` context shows it.
interface Triggered {
  readonly action: string
  // An `edited` event's `changes`: each field edited, with its old value.
  readonly changes?: Record<string, unknown>
  readonly pr: number
  readonly runId: number
}

// A workflow string with each ${{ }} evaluated for the event by GitHub's own
// expression library: the workflow runs from the base branch, so a PR that
// edits it can't try it.
const expand = (text: string, { action, changes, pr, runId }: Triggered) => {
  const github = new data.Dictionary({
    key: "github",
    value: JSON.parse(
      JSON.stringify({
        run_id: runId,
        event: { action, changes, pull_request: { number: pr } },
      }),
      data.reviver
    ),
  })
  return text.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    new Evaluator(
      new Parser(new Lexer(expression).lex().tokens, ["github"], []).parse(),
      github
    )
      .evaluate()
      .coerceString()
  )
}

const push: Triggered = { action: "synchronize", pr: 7, runId: 100 }
const label: Triggered = { action: "labeled", pr: 7, runId: 101 }
const retarget: Triggered = {
  action: "edited",
  changes: { base: { ref: { from: "main" }, sha: { from: sha } } },
  pr: 7,
  runId: 102,
}
const titleEdit: Triggered = {
  action: "edited",
  changes: { title: { from: "An old title" } },
  pr: 7,
  runId: 103,
}
const bodyEdit: Triggered = {
  action: "edited",
  changes: { body: { from: "An old body" } },
  pr: 7,
  runId: 104,
}

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

  it.effect(
    "runs on the six types that change the head, its labels or its base",
    () =>
      Effect.gen(function* () {
        const workflow = yield* gateWorkflow
        assert.deepStrictEqual(
          Object.values(workflow.on).map((trigger) =>
            [...trigger.types].sort()
          ),
          [
            [
              "edited",
              "labeled",
              "opened",
              "reopened",
              "synchronize",
              "unlabeled",
            ],
          ]
        )
      })
  )

  it.effect(
    "skips an edit that leaves the base alone, so a new title or body doesn't rerun it",
    () =>
      Effect.gen(function* () {
        const job = yield* gateJob
        assert.strictEqual(job.if, notATitleOrBodyEdit)
      })
  )

  it.effect(
    "never lets a skipped edit cancel the gate run of a push or label before it",
    () =>
      Effect.gen(function* () {
        const workflow = yield* gateWorkflow
        assert.strictEqual(
          workflow.concurrency["cancel-in-progress"],
          `\${{ ${notATitleOrBodyEdit} }}`
        )
      })
  )

  it.effect(
    "keeps a PR's pushes, labels and retargets in one concurrency group, apart from another PR's",
    () =>
      Effect.gen(function* () {
        const { concurrency } = yield* gateWorkflow
        const ofPr = expand(concurrency.group, push)
        assert.strictEqual(expand(concurrency.group, label), ofPr)
        assert.strictEqual(expand(concurrency.group, retarget), ofPr)
        assert.notStrictEqual(
          expand(concurrency.group, { ...push, pr: 8 }),
          ofPr
        )
      })
  )

  it.effect(
    "keeps a title or body edit, whose job is skipped, out of the PR's concurrency group, where GitHub would let it replace a pending push or label run",
    () =>
      Effect.gen(function* () {
        const { concurrency } = yield* gateWorkflow
        const job = yield* gateJob
        const ofPr = expand(concurrency.group, push)
        for (const edit of [titleEdit, bodyEdit]) {
          assert.strictEqual(expand(`\${{ ${job.if} }}`, edit), "false")
          assert.notStrictEqual(expand(concurrency.group, edit), ofPr)
        }
        assert.notStrictEqual(
          expand(concurrency.group, titleEdit),
          expand(concurrency.group, bodyEdit)
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
    "turns its own success red again once the label is removed or a retarget brings app code into the diff",
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
