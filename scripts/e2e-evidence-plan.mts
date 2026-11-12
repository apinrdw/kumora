// The evidence command's decisions, with no I/O. Before the run, `preflight`
// checks the preconditions and picks the specs; after it, `evidencePlan` reads
// Playwright's JSON report and either refuses or says what to post.
// scripts/e2e-evidence.mts gathers the inputs and does the posting.
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
  // Errors outside any test: a config or global setup failure, test.only.
  errors: Schema.Array(
    Schema.Struct({ message: Schema.optionalKey(Schema.String) })
  ),
  stats: Schema.Struct({ duration: Schema.Number, expected: Schema.Number }),
})

// The annotation apps/e2e/support/test.ts gives each test: its results folder.
const RESULTS_FOLDER = "results-folder"

// Decision: the status context the gate (.github/workflows/e2e-evidence.yml)
// reads, set with the author's own gh login so the gate keeps it
// (apinrdw/kumora#203, #211).
const CONTEXT = "e2e-evidence"

// Decision: `gh pr comment --attach` first ships in gh 2.99.0, so a real run
// refuses an older gh rather than fail at the post (apinrdw/kumora#204).
const GH_MINIMUM = [2, 99, 0] as const

// Decision: GitHub's upload cap on the paid plan is 100 MB a video, counted
// in decimal megabytes so a video at the edge is refused here, not by the
// upload (apinrdw/kumora#205).
const VIDEO_CAP_MB = 100
const MB = 1_000_000

// Decision: a spec file is a *.spec.ts under apps/e2e/tests; setup files and
// support modules change no test's video (apinrdw/kumora#202).
const SPEC_FILE = /^apps\/e2e\/tests\/.+\.spec\.ts$/

export class EvidenceRefused extends Schema.TaggedError<EvidenceRefused>()(
  "EvidenceRefused",
  { reason: Schema.String }
) {
  override get message() {
    return this.reason
  }
}

interface Pr {
  readonly number: number
  readonly headSha: string
}

export interface PreflightInputs {
  /** The spec files the author named, as typed: `x.spec.ts` or a path ending in it. */
  readonly named: ReadonlyArray<string>
  /** Repo-relative files the branch changes against the PR's base ref. */
  readonly changed: ReadonlyArray<string>
  /** What `git status --porcelain` prints, a line per dirty path. */
  readonly dirty: ReadonlyArray<string>
  /** The local HEAD's SHA. */
  readonly head: string
  /** The branch's PR, or the one --pr names; undefined when there is none. */
  readonly pr: Pr | undefined
  /** What `gh --version` prints. */
  readonly gh: string
  readonly dryRun: boolean
}

const ghVersion = Effect.fnUntraced(function* (printed: string) {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(printed)
  return match === null ? undefined : [1, 2, 3].map((at) => Number(match[at]))
})

const ghTooOld = Effect.fnUntraced(function* (printed: string) {
  const version = yield* ghVersion(printed)
  if (version === undefined)
    return `gh printed no version I can read (${printed.trim() || "nothing"}); posting needs gh 2.99.0 or newer.`
  const order = version
    .map((part, at) => part - (GH_MINIMUM[at] ?? 0))
    .find((difference) => difference !== 0)
  return order !== undefined && order < 0
    ? `gh ${version.join(".")} is older than 2.99.0, the first with \`gh pr comment --attach\`. Upgrade gh.`
    : undefined
})

/**
 * Before the run: refuses what a run can't vouch for and picks the specs, the
 * named ones then each changed spec file. Its `unmet` lists what a real run
 * would refuse but a dry run lets past.
 */
export const preflight = Effect.fn("preflight")(function* ({
  named,
  changed,
  dirty,
  head,
  pr,
  gh,
  dryRun,
}: PreflightInputs) {
  const oldGh = yield* ghTooOld(gh)
  const unmet = [
    ...(dirty.length > 0
      ? [
          `The working tree is dirty, so the run would not be of the commit it vouches for. Commit or stash:\n${dirty.map((line) => `  ${line}`).join("\n")}`,
        ]
      : []),
    ...(pr !== undefined && head !== pr.headSha
      ? [
          `Local HEAD ${head} is not PR #${pr.number}'s pushed head ${pr.headSha}. Push, or check out the PR's head.`,
        ]
      : []),
    ...(oldGh === undefined ? [] : [oldGh]),
  ]
  // Decision: a dry run posts nothing and sets no status, so it runs past
  // the preconditions that protect the post (a dirty tree, HEAD not the PR
  // head, a gh without --attach) and prints them instead. It still needs a
  // PR and a selection to plan the post (apinrdw/kumora#212).
  const blocking = [
    ...(pr === undefined
      ? ["No PR for this branch. Open one and push, or name it with --pr <n>."]
      : []),
    ...(dryRun ? [] : unmet),
  ]
  if (pr === undefined || blocking.length > 0)
    return yield* new EvidenceRefused({ reason: blocking.join("\n") })

  const specs = [
    ...new Set([...named, ...changed.filter((file) => SPEC_FILE.test(file))]),
  ]
  if (specs.length === 0)
    return yield* new EvidenceRefused({
      reason:
        "No spec to show: none is named and no spec file changed. Name a spec file (pnpm e2e:evidence <spec...>), or give a PR with no visible behaviour change the no-e2e-evidence label.",
    })
  return { pr, specs, unmet }
})

/** A file in a test's results folder. */
interface ResultFile {
  /** Repo-relative. */
  readonly path: string
  readonly bytes: number
}

export interface EvidenceInputs {
  /** The specs preflight picked. */
  readonly specs: ReadonlyArray<string>
  readonly pr: Pr
  /** Playwright's exit code. */
  readonly exitCode: number
  readonly report: typeof PlaywrightReport.Type
  /** Each results folder, as the report names it, to the files in it. */
  readonly files: ReadonlyMap<string, ReadonlyArray<ResultFile>>
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

// The files in a test's results folder whose names pass `keep`, sorted by
// path so a rerun lists them alike.
const testFiles = Effect.fnUntraced(function* (
  { test }: Titled,
  files: EvidenceInputs["files"],
  keep: (name: string) => boolean
) {
  const folder = yield* resultsFolder(test)
  return ((folder === undefined ? undefined : files.get(folder)) ?? [])
    .filter((file) => keep(file.path.split("/").at(-1) ?? ""))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

// Decision: a test can write several videos (the built-in page's, each
// hand-built context's page@<hex>.webm), so every .webm in its results folder
// goes under its title. A test that opens no page is still listed, as "no
// page, no video", so the reader sees it ran (apinrdw/kumora#211).
const isVideo = (name: string) => name.endsWith(".webm")
const isTrace = (name: string) =>
  name.startsWith("trace") && name.endsWith(".zip")

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
  videos: ReadonlyArray<ResultFile>
) {
  const shown =
    titled.test.status === "skipped"
      ? ["Skipped."]
      : videos.length === 0
        ? ["No page, no video."]
        : videos.map((video) => `![](${video.path})`)
  return [`#### ${titled.title}`, ...shown]
})

// Decision: any failure blocks the post, in a picked spec or not, and so does
// a non-zero exit with no failed test (a global setup error, a test.only).
// Nothing is posted and the status is left alone; the author gets each
// failure's video and trace to look at (apinrdw/kumora#207).
const redRun = Effect.fnUntraced(function* (
  tests: ReadonlyArray<Titled>,
  { exitCode, report, files }: EvidenceInputs
) {
  const failed = tests.filter(
    ({ test }) => test.status === "unexpected" || test.status === "flaky"
  )
  if (failed.length === 0 && exitCode === 0 && report.errors.length === 0)
    return undefined
  const listed = yield* Effect.forEach(failed, (titled) =>
    Effect.gen(function* () {
      const videos = yield* testFiles(titled, files, isVideo)
      const traces = yield* testFiles(titled, files, isTrace)
      return [
        `${titled.file} › ${titled.title}`,
        ...videos.map((video) => `  video: ${video.path}`),
        ...traces.map((trace) => `  trace: ${trace.path}`),
      ].join("\n")
    })
  )
  const count = `${failed.length} failed ${failed.length === 1 ? "test" : "tests"}`
  return [
    `Playwright exited ${exitCode} with ${count}, so nothing was posted and the ${CONTEXT} status is unchanged. Fix the run and try again.`,
    ...listed,
    ...report.errors.map(
      (error) => error.message ?? "An error with no message."
    ),
  ].join("\n")
})

/** After the run: what to post from a green run, or why not. */
export const evidencePlan = Effect.fn("evidencePlan")(function* (
  inputs: EvidenceInputs
) {
  const { specs, pr, report, files } = inputs
  const tests = (yield* Effect.forEach(report.suites, (suite) =>
    titledTests(suite, [])
  )).flat()
  const red = yield* redRun(tests, inputs)
  if (red !== undefined) return yield* new EvidenceRefused({ reason: red })

  const ran = [...new Set(tests.map((test) => test.file))]
  // The files each picked spec names, in the order they were picked.
  const picked = [...new Set(specs)]
  const matches = yield* Effect.forEach(picked, (spec) =>
    Effect.filter(ran, (file) => namesFile(spec, file))
  )
  const unknown = picked.filter((_, index) => matches[index]?.length === 0)
  if (unknown.length > 0)
    return yield* new EvidenceRefused({
      reason: `No test in the run comes from ${unknown.join(", ")}. Name spec files under apps/e2e/tests.`,
    })
  const selected = [...new Set(matches.flat())]

  const attached: Array<ResultFile & { readonly test: string }> = []
  const paragraphs: Array<string> = [
    "## e2e evidence",
    `The full suite passed on ${pr.headSha}: ${report.stats.expected} passed in ${Math.round(report.stats.duration / 1000)} s.`,
  ]
  for (const file of selected) {
    paragraphs.push(`### ${file}`)
    for (const titled of tests.filter((test) => test.file === file)) {
      const own = yield* testFiles(titled, files, isVideo)
      attached.push(
        ...own.map((video) => ({ ...video, test: `${file} › ${titled.title}` }))
      )
      paragraphs.push(...(yield* section(titled, own)))
    }
  }
  const oversize = attached.filter((video) => video.bytes > VIDEO_CAP_MB * MB)
  if (oversize.length > 0)
    return yield* new EvidenceRefused({
      reason: [
        `GitHub takes videos up to ${VIDEO_CAP_MB} MB, so nothing was posted. Shorten these tests:`,
        ...oversize.map(
          (video) =>
            `${video.test}\n  video: ${video.path} (${(video.bytes / MB).toFixed(1)} MB)`
        ),
      ].join("\n"),
    })
  return {
    pr: pr.number,
    videos: attached.map((video) => video.path),
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
