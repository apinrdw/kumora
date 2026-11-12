// The evidence command's decisions, with no I/O: from the named specs, the
// PR and a finished run's Playwright JSON report, either a refusal or what to
// post. scripts/e2e-evidence.mts gathers the inputs and does the posting.
import { Effect, Schema } from "effect"

import { CheckFailed } from "./lib/check.mts"

const Annotation = Schema.Struct({
  type: Schema.String,
  description: Schema.optionalKey(Schema.String),
})
const Result = Schema.Struct({ annotations: Schema.Array(Annotation) })
const Test = Schema.Struct({
  status: Schema.Literals(["skipped", "expected", "unexpected", "flaky"]),
  results: Schema.Array(Result),
})
const Spec = Schema.Struct({
  title: Schema.String,
  file: Schema.String,
  tests: Schema.Array(Test),
})
interface Suite {
  readonly title: string
  readonly file: string
  readonly specs: ReadonlyArray<typeof Spec.Type>
  readonly suites?: ReadonlyArray<Suite>
}
const Suite: Schema.Codec<Suite> = Schema.Struct({
  title: Schema.String,
  file: Schema.String,
  specs: Schema.Array(Spec),
  suites: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<Suite> => Suite))
  ),
})

/** The part of Playwright's JSON reporter output the plan reads. */
export const PlaywrightReport = Schema.Struct({
  suites: Schema.Array(Suite),
  stats: Schema.Struct({ duration: Schema.Number, expected: Schema.Number }),
})

// The annotation apps/e2e/support/test.ts gives each test: its results folder.
const RESULTS_FOLDER = "results-folder"

// Decision: the status context the gate (.github/workflows/e2e-evidence.yml)
// reads, set with the author's own gh login so the gate keeps it
// (apinrdw/kumora#203, #211).
const CONTEXT = "e2e-evidence"

export class EvidenceRefused extends Schema.TaggedError<EvidenceRefused>()(
  "EvidenceRefused",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

export interface EvidenceInputs {
  /** The spec files the author named, as typed: `x.spec.ts` or a path ending in it. */
  readonly specs: ReadonlyArray<string>
  readonly pr: { readonly number: number; readonly headSha: string }
  readonly report: typeof PlaywrightReport.Type
  /** Each results folder, as the report names it, to the repo-relative `.webm` files in it. */
  readonly videos: ReadonlyMap<string, ReadonlyArray<string>>
}

interface PostPlan {
  readonly pr: number
  /** In the order the body embeds them. */
  readonly videos: ReadonlyArray<string>
  readonly body: string
  /** The commit status to set once the comment is up; its target is the comment. */
  readonly status: {
    readonly sha: string
    readonly state: "success"
    readonly context: typeof CONTEXT
    readonly description: string
  }
}

interface Titled {
  readonly file: string
  readonly title: string
  readonly test: typeof Test.Type
}

// Every test in the report with its file and its title below the file
// (describe titles, then the test's, as the list reporter joins them).
const titledTests: (
  suite: Suite,
  above: ReadonlyArray<string>
) => Effect.Effect<ReadonlyArray<Titled>> = Effect.fnUntraced(
  function* (suite, above) {
    const own = suite.specs.flatMap((spec) =>
      spec.tests.map((test) => ({
        file: spec.file,
        title: [...above, spec.title].join(" › "),
        test,
      }))
    )
    const nested = yield* Effect.forEach(suite.suites ?? [], (child) =>
      titledTests(child, [...above, child.title])
    )
    return [...own, ...nested.flat()]
  }
)

const namesFile = Effect.fnUntraced(function* (spec: string, file: string) {
  return spec === file || spec.endsWith(`/${file}`)
})

// Decision: a test can write several videos (the built-in page's, each
// hand-built context's page@<hex>.webm), so every .webm in its results folder
// goes under its title, sorted by file name so a rerun lists them alike. A
// test that opens no page is still listed, as "no page, no video", so the
// reader sees it ran (apinrdw/kumora#211).
const testVideos = Effect.fnUntraced(function* (
  { test }: Titled,
  videos: EvidenceInputs["videos"]
) {
  const folder = yield* resultsFolder(test)
  return [...((folder && videos.get(folder)) ?? [])].sort()
})

const resultsFolder = Effect.fnUntraced(function* (test: typeof Test.Type) {
  return test.results
    .at(-1)
    ?.annotations.find((note) => note.type === RESULTS_FOLDER)?.description
})

/** Every results folder the report names, for the shell to list. */
export const resultsFolders = Effect.fn("resultsFolders")(function* (
  report: typeof PlaywrightReport.Type
) {
  const tests = yield* Effect.forEach(report.suites, (suite) =>
    titledTests(suite, [])
  )
  const folders = yield* Effect.forEach(tests.flat(), ({ test }) =>
    resultsFolder(test)
  )
  return [...new Set(folders)].filter((folder) => folder !== undefined)
})

const section = Effect.fnUntraced(function* (
  titled: Titled,
  videos: ReadonlyArray<string>
) {
  const shown =
    titled.test.status === "skipped"
      ? ["Skipped."]
      : videos.length === 0
        ? ["No page, no video."]
        : videos.map((video) => `![](${video})`)
  return [`#### ${titled.title}`, ...shown]
})

export const evidencePlan = Effect.fn("evidencePlan")(function* ({
  specs,
  pr,
  report,
  videos,
}: EvidenceInputs) {
  const tests = (yield* Effect.forEach(report.suites, (suite) =>
    titledTests(suite, [])
  )).flat()
  const files = [...new Set(tests.map((test) => test.file))]
  // The files each named spec names, in the order the author named them.
  const named = [...new Set(specs)]
  const matches = yield* Effect.forEach(named, (spec) =>
    Effect.filter(files, (file) => namesFile(spec, file))
  )
  const unknown = named.filter((_, index) => matches[index]?.length === 0)
  if (unknown.length > 0)
    return yield* new EvidenceRefused({
      reason: `No test in the run comes from ${unknown.join(", ")}. Name spec files under apps/e2e/tests.`,
    })
  const selected = [...new Set(matches.flat())]

  const attached: Array<string> = []
  const paragraphs: Array<string> = [
    "## e2e evidence",
    `The full suite passed on ${pr.headSha}: ${report.stats.expected} passed in ${Math.round(report.stats.duration / 1000)} s.`,
  ]
  for (const file of selected) {
    paragraphs.push(`### ${file}`)
    for (const titled of tests.filter((test) => test.file === file)) {
      const own = yield* testVideos(titled, videos)
      attached.push(...own)
      paragraphs.push(...(yield* section(titled, own)))
    }
  }
  return {
    pr: pr.number,
    videos: attached,
    body: [...paragraphs, ""].join("\n\n"),
    status: {
      sha: pr.headSha,
      state: "success",
      context: CONTEXT,
      description: `Full suite passed: ${report.stats.expected} tests. Videos in the PR comment.`,
    },
  } satisfies PostPlan
})

/** The comment's URL, from what `gh pr comment` prints. */
export const commentUrl = Effect.fn("commentUrl")(function* (stdout: string) {
  const url = /https:\/\/github\.com\/\S+#issuecomment-\d+/.exec(stdout)?.[0]
  if (url === undefined)
    return yield* new CheckFailed({
      summary: "gh pr comment printed no comment URL:",
      findings: [stdout.trimEnd()],
    })
  return url
})
