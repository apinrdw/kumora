// The evidence command's decisions, with no I/O. Before the run, `preflight`
// checks the preconditions and picks the specs; after it, `evidencePlan` reads
// the JSON report of the picked specs' run and either refuses or says what to
// post. The whole suite runs in CI (.github/workflows/e2e.yml).
// scripts/e2e-evidence.mts gathers the inputs and does the posting.
import { Effect, Path, Schema } from "effect"

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

// The commit status the gate (.github/workflows/e2e-evidence.yml) reads and
// the label it takes as an opt-out; the gate names both again, so change them
// together.
// Decision: e2e-evidence is a commit status, red until evidence or the label
// (docs/adr/0006-the-e2e-evidence-gate-is-a-commit-status-from-its-own-workflow.md)
const CONTEXT = "e2e-evidence"
const OPT_OUT_LABEL = "no-e2e-evidence"

// `gh pr comment --attach` first ships in gh 2.99.0, so a real run
// refuses an older gh rather than fail at the post (apinrdw/kumora#204).
const GH_MINIMUM = [2, 99, 0] as const

// GitHub's upload cap on the paid plan is 100 MB a video, counted
// in decimal megabytes so a video at the edge is refused here, not by the
// upload (apinrdw/kumora#205).
const VIDEO_CAP_MB = 100
const MB = 1_000_000

// Each comment carries at most 50 videos, the most `gh pr comment`
// takes per command (gh 2.103.3's help). More videos are split, in pick order,
// into as many comments as they need, and the status links the first. A
// single comment refused every PR that changes many specs: apinrdw/kumora#449
// had 86 videos.
const ATTACH_CAP = 50

/** The folder each comment's body is written to; gh runs from it. */
const BODY_DIR = "apps/e2e/test-results"

// Only a *.spec.ts under apps/e2e/tests is picked, not every changed
// file under apps/e2e: a setup file or support module is no one test's video
// (apinrdw/kumora#202).
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

/** The checkout as git reports it at one moment: before the run, or after it. */
interface Checkout {
  /** What `git status --porcelain` prints, a line per dirty path. */
  readonly dirty: ReadonlyArray<string>
  /** The local HEAD's SHA. */
  readonly head: string
}

export interface PreflightInputs extends Checkout {
  /** The spec files the author named, as typed: `x.spec.ts` or a path ending in it. */
  readonly named: ReadonlyArray<string>
  /** Repo-relative files the branch changes against the PR's base ref. */
  readonly changed: ReadonlyArray<string>
  /** The branch's PR, or the one --pr names; undefined when there is none. */
  readonly pr: Pr | undefined
  /** What `gh --version` prints. */
  readonly gh: string
  readonly dryRun: boolean
}

// The files a spec as typed names. Either path may be the longer: a changed
// file is repo-relative, the report's is relative to apps/e2e/tests, and the
// author may type either or something between. apps/e2e/support/video.ts
// matches the picked specs it records by this rule less the shorter-spec case
// (isNamedBy), since its files sit directly in tests/, so change the two
// together.
const filesOf = Effect.fnUntraced(function* (
  spec: string,
  files: ReadonlyArray<string>
) {
  return files.filter(
    (file) =>
      file === spec || file.endsWith(`/${spec}`) || spec.endsWith(`/${file}`)
  )
})

const ghVersion = Effect.fnUntraced(function* (printed: string) {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/.exec(printed)
  return match === null ? undefined : [1, 2, 3].map((at) => Number(match[at]))
})

const ghTooOld = Effect.fnUntraced(function* (printed: string) {
  const version = yield* ghVersion(printed)
  const minimum = GH_MINIMUM.join(".")
  if (version === undefined)
    return `gh printed no version I can read (${printed.trim() || "nothing"}); posting needs gh ${minimum} or newer.`
  const firstDifference = version
    .map((part, at) => part - (GH_MINIMUM[at] ?? 0))
    .find((difference) => difference !== 0)
  return firstDifference !== undefined && firstDifference < 0
    ? `gh ${version.join(".")} is older than ${minimum}, the first with \`gh pr comment --attach\`. Upgrade gh.`
    : undefined
})

// Why a run of this checkout would not be a run of the PR's head. preflight
// asks before the run, evidencePlan again after it.
const offThePrHead = Effect.fnUntraced(function* (
  { dirty, head }: Checkout,
  pr: Pr | undefined
) {
  return [
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
  ]
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
    ...(yield* offThePrHead({ dirty, head }, pr)),
    ...(oldGh === undefined ? [] : [oldGh]),
  ]
  // A dry run posts nothing and sets no status, so it runs past
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

  // A changed spec the author already named is not picked twice.
  const covered = (yield* Effect.forEach(named, (spec) =>
    filesOf(spec, changed)
  )).flat()
  const added = changed.filter(
    (file) => SPEC_FILE.test(file) && !covered.includes(file)
  )
  const specs = [...new Set([...named, ...added])]
  if (specs.length === 0)
    return yield* new EvidenceRefused({
      reason: `No spec to show: none is named and no spec file changed. Name a spec file (vp run e2e:evidence <spec...>), or give a PR with no visible behaviour change the ${OPT_OUT_LABEL} label.`,
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
  /** The checkout once the run has ended. */
  readonly checkout: Checkout
  readonly dryRun: boolean
}

/** One PR comment: its part of the videos, in pick order. */
export interface EvidenceComment {
  /** Repo-relative, in BODY_DIR; `body` goes into it. */
  readonly bodyFile: string
  /** Relative to BODY_DIR, in the order the body embeds them. */
  readonly videos: ReadonlyArray<string>
  readonly body: string
}

export interface PostPlan {
  /** What a real run would have refused but a dry run got past; empty on a real run. */
  readonly unmet: ReadonlyArray<string>
  readonly pr: number
  /** In posting order; never empty. */
  readonly comments: ReadonlyArray<EvidenceComment>
  /** The commit status to set once every comment is up; its target is the first. */
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

// Every test in the report, in report order.
const reportTests = Effect.fnUntraced(function* (
  report: typeof PlaywrightReport.Type
) {
  const bySuite = yield* Effect.forEach(report.suites, (suite) =>
    titledTests(suite, [])
  )
  return bySuite.flat()
})

// The files in a test's results folder whose names match `kind`, sorted by
// path so a rerun lists them alike.
const testFiles = Effect.fnUntraced(function* (
  { test }: Titled,
  files: EvidenceInputs["files"],
  kind: RegExp
) {
  const folder = yield* resultsFolder(test)
  return ((folder === undefined ? undefined : files.get(folder)) ?? [])
    .filter((file) => kind.test(file.path.split("/").at(-1) ?? ""))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
})

// Every .webm in a test's results folder goes under its title, not
// only the video the JSON report attaches, which leaves out each hand-built
// context's page@<hex>.webm. A test that opens no page is still listed, as "no
// page, no video", so the reader sees it ran (apinrdw/kumora#211).
const VIDEO = /\.webm$/
const TRACE = /^trace.*\.zip$/

const resultsFolder = Effect.fnUntraced(function* (test: typeof Test.Type) {
  return test.results
    .at(-1)
    ?.annotations.find((note) => note.type === RESULTS_FOLDER)?.description
})

/** Every results folder the report names, for the shell to list. */
export const resultsFolders = Effect.fn("resultsFolders")(function* (
  report: typeof PlaywrightReport.Type
) {
  const folders = yield* Effect.forEach(
    yield* reportTests(report),
    ({ test }) => resultsFolder(test)
  )
  return [...new Set(folders)].filter((folder) => folder !== undefined)
})

// One paragraph of a comment under its test's title: a video, or why there
// is none.
interface Paragraph {
  readonly titled: Titled
  readonly text: string
  /** Relative to BODY_DIR, when the paragraph embeds a video. */
  readonly video?: string
}

const section = Effect.fnUntraced(function* (
  titled: Titled,
  videos: ReadonlyArray<string>
) {
  if (titled.test.status === "skipped") return [{ titled, text: "Skipped." }]
  if (videos.length === 0) return [{ titled, text: "No page, no video." }]
  return videos.map((video) => ({ titled, text: `![](${video})`, video }))
})

// The paragraphs, in pick order, cut into comments of at most ATTACH_CAP
// videos. A paragraph with no video goes with the videos before it. Each
// comment heads its first paragraph with its spec file and test title again,
// so a test cut between two comments is titled in both.
const splitComments = Effect.fnUntraced(function* (
  paragraphs: ReadonlyArray<Paragraph>,
  summary: string
) {
  const videoCount = paragraphs.filter((p) => p.video !== undefined).length
  const count = Math.max(1, Math.ceil(videoCount / ATTACH_CAP))
  const parts = Array.from({ length: count }, (): Array<Paragraph> => [])
  let before = 0
  for (const paragraph of paragraphs) {
    parts[Math.min(Math.floor(before / ATTACH_CAP), count - 1)]?.push(paragraph)
    if (paragraph.video !== undefined) before += 1
  }
  return parts.map((own, at): EvidenceComment => {
    const lines = [
      count === 1
        ? "## e2e evidence"
        : `## e2e evidence, part ${at + 1} of ${count}`,
      summary,
    ]
    own.forEach(({ titled, text }, index) => {
      const previous = own[index - 1]?.titled
      if (previous?.file !== titled.file) lines.push(`### ${titled.file}`)
      if (previous !== titled) lines.push(`#### ${titled.title}`)
      lines.push(text)
    })
    return {
      bodyFile: `${BODY_DIR}/e2e-evidence-${at + 1}.md`,
      videos: own.flatMap(({ video }) => (video === undefined ? [] : [video])),
      body: [...lines, ""].join("\n\n"),
    }
  })
})

// Any failure blocks the post, in a picked spec or in setup, and so
// does a non-zero exit with no failed test (a global setup error, a test.only).
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
      const videos = yield* testFiles(titled, files, VIDEO)
      const traces = yield* testFiles(titled, files, TRACE)
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
  const path = yield* Path.Path
  const { specs, pr, report, files, checkout, dryRun } = inputs
  const tests = yield* reportTests(report)
  const red = yield* redRun(tests, inputs)
  if (red !== undefined) return yield* new EvidenceRefused({ reason: red })

  // The checkout is read again once the run ends, because the dev
  // servers serve the working tree: an edit or a switched commit mid-run means
  // the run did not test the PR's head. A throwaway checkout per run would
  // also catch an edit undone before the end, but adds an install and a cold
  // local state to every run (apinrdw/kumora#217). A dry run is only told.
  const unmet = yield* offThePrHead(checkout, pr)
  if (unmet.length > 0 && !dryRun)
    return yield* new EvidenceRefused({
      reason: [
        `The checkout changed while the specs ran, so nothing was posted and the ${CONTEXT} status is unchanged. Run it again and leave the checkout alone until it ends.`,
        ...unmet,
      ].join("\n"),
    })

  const ran = [...new Set(tests.map((test) => test.file))]
  // The files each picked spec names, in the order they were picked.
  const picked = [...new Set(specs)]
  const matches = yield* Effect.forEach(picked, (spec) => filesOf(spec, ran))
  const unknown = picked.filter((_, index) => matches[index]?.length === 0)
  if (unknown.length > 0)
    return yield* new EvidenceRefused({
      reason: `No test in the run comes from ${unknown.join(", ")}. Name spec files under apps/e2e/tests.`,
    })
  const selected = [...new Set(matches.flat())]

  const attached: Array<ResultFile & { readonly test: string }> = []
  const paragraphs: Array<Paragraph> = []
  for (const file of selected) {
    for (const titled of tests.filter((test) => test.file === file)) {
      const own = (yield* testFiles(titled, files, VIDEO)).map((video) => ({
        ...video,
        test: `${file} › ${titled.title}`,
      }))
      attached.push(...own)
      paragraphs.push(
        ...(yield* section(
          titled,
          // The body and --attach name each video from the body
          // file's folder, where gh runs, written ./x as gh's help does, not
          // repo-relative: gh reads a --body-file's paths from its folder and
          // only falls back to the working directory (gh 2.103.3's help).
          own.map((video) => `./${path.relative(BODY_DIR, video.path)}`)
        ))
      )
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
  const comments = yield* splitComments(
    paragraphs,
    `The picked specs passed on ${pr.headSha}: ${report.stats.expected} passed in ${Math.round(report.stats.duration / 1000)} s. The whole suite's result is CI's \`e2e\` check.`
  )
  return {
    unmet,
    pr: pr.number,
    comments,
    status: {
      sha: pr.headSha,
      state: "success",
      context: CONTEXT,
      description: `Picked specs passed: ${report.stats.expected} tests. Videos in ${comments.length === 1 ? "the PR comment" : `${comments.length} PR comments`}.`,
    },
  } satisfies PostPlan
})

const causeOf = Effect.fnUntraced(function* (error: unknown) {
  return error instanceof Error ? error.message : String(error)
})

/**
 * Posts the plan's comments in order, then sets its status on the first
 * one's URL. A comment that fails stops the post with no status set, naming
 * the parts already up. Returns each comment's URL.
 */
export const postEvidence = Effect.fn("postEvidence")(function* <E, R>(
  plan: PostPlan,
  post: {
    /** Posts one comment and returns its URL. */
    readonly comment: (comment: EvidenceComment) => Effect.Effect<string, E, R>
    readonly status: (target: string) => Effect.Effect<void, E, R>
  }
) {
  const count = plan.comments.length
  const urls: Array<string> = []
  for (const [at, comment] of plan.comments.entries()) {
    const url = yield* post.comment(comment).pipe(
      Effect.catch((error) =>
        Effect.flatMap(
          causeOf(error),
          (cause) =>
            new EvidenceRefused({
              reason: [
                `Part ${at + 1} of ${count} did not post, so the ${CONTEXT} status is unchanged.`,
                urls.length === 0
                  ? "No part was posted."
                  : `Posted, and left on the PR:\n${urls.map((posted, index) => `  part ${index + 1}: ${posted}`).join("\n")}`,
                cause,
              ].join("\n"),
            })
        )
      )
    )
    urls.push(url)
  }
  const [first] = urls
  if (first !== undefined) yield* post.status(first)
  return urls
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
