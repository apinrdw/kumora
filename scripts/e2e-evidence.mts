// `pnpm e2e:evidence [--pr <n>] [--dry-run] [spec...]`: runs the full e2e
// suite, recording video of only the picked specs, posts their videos to the
// PR as comments of at most 50 videos each and, once every one is up, marks
// the PR head `e2e-evidence: success`, linking to the first. Every decision
// is in scripts/e2e-evidence-plan.mts; this file runs git, gh and Playwright.
// --dry-run prints every comment and the gh calls instead of making them.
import { availableParallelism } from "node:os"
import { parseArgs as parseCliArgs } from "node:util"

import { ByteSize, Console, Effect, FileSystem, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  commentUrl,
  evidencePlan,
  postEvidence,
  preflight,
  resultsFolders,
  PlaywrightReport,
  type EvidenceComment,
} from "./e2e-evidence-plan.mts"
import { CheckFailed, repoRoot } from "./lib/check.mts"
import { collect, CommandFailed, gitLines, stdoutOf } from "./lib/command.mts"
import { runScript } from "./lib/run.mts"

const USAGE = "Usage: pnpm e2e:evidence [--pr <n>] [--dry-run] [spec...]"

const Pr = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Number,
    headRefOid: Schema.String,
    baseRefName: Schema.String,
  })
)

const parseArgs = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const parsed = yield* Effect.try({
    try: () =>
      parseCliArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          pr: { type: "string" },
          "dry-run": { type: "boolean", default: false },
        },
      }),
    catch: (error) =>
      new CheckFailed({ summary: USAGE, findings: [String(error)] }),
  })
  const { pr, "dry-run": dryRun } = parsed.values
  if (pr !== undefined && !/^\d+$/.test(pr))
    return yield* new CheckFailed({ summary: USAGE, findings: [`--pr ${pr}`] })
  return { specs: parsed.positionals, pr, dryRun }
})

// The branch's PR, or the one --pr names; undefined when gh finds none.
const findPr = Effect.fnUntraced(function* (
  root: string,
  prArg: string | undefined
) {
  const args = [
    "pr",
    "view",
    ...(prArg ? [prArg] : []),
    "--json",
    "number,headRefOid,baseRefName",
  ]
  const result = yield* collect(ChildProcess.make("gh", args, { cwd: root }))
  if (result.exitCode !== 0 && /no pull requests found/i.test(result.stderr))
    return undefined
  if (result.exitCode !== 0)
    return yield* new CommandFailed({
      command: ["gh", ...args].join(" "),
      exitCode: result.exitCode,
      stderr: result.stderr,
    })
  return yield* Schema.decodeEffect(Pr)(result.stdout)
})

// The checkout as git reports it now, read before the run and again after it.
const readCheckout = Effect.fnUntraced(function* (root: string) {
  return {
    dirty: yield* gitLines(root, ["status", "--porcelain"]),
    head: (yield* stdoutOf("git", ["rev-parse", "HEAD"], { cwd: root })).trim(),
  }
})

// Runs a command on this terminal and returns its exit code.
const runOnTerminal = Effect.fn("runOnTerminal")(function* (
  command: ChildProcess.Command
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(command)
  return yield* handle.exitCode
}, Effect.scoped)

// Each results folder the report names, to the files in it, repo-relative
// with their sizes. A test that opens no page may leave no folder.
const listFiles = Effect.fnUntraced(function* (
  root: string,
  report: typeof PlaywrightReport.Type
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* Effect.forEach(
    yield* resultsFolders(report),
    (folder) =>
      Effect.gen(function* () {
        const names = yield* Effect.orElseSucceed(
          fs.readDirectory(folder),
          () => []
        )
        const files = yield* Effect.forEach(names, (name) =>
          Effect.map(fs.stat(path.join(folder, name)), (info) => ({
            path: path.relative(root, path.join(folder, name)),
            bytes: Number(ByteSize.toBigInt(info.size)),
          }))
        )
        return [folder, files] as const
      })
  )
  return new Map(listed)
})

const e2eEvidence = Effect.fn("e2eEvidence")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { specs: named, pr: prArg, dryRun } = yield* parseArgs(args)

  const found = yield* findPr(root, prArg)
  // Changed specs are diffed from the merge base with the PR's base
  // as last fetched, without deleted files, which no longer run a test
  // (apinrdw/kumora#202).
  const changed =
    found === undefined
      ? []
      : yield* gitLines(root, [
          "diff",
          "--name-only",
          "--diff-filter=d",
          (yield* stdoutOf(
            "git",
            ["merge-base", "HEAD", `origin/${found.baseRefName}`],
            { cwd: root }
          )).trim(),
          "HEAD",
        ])
  const { pr, specs, unmet } = yield* preflight({
    named,
    changed,
    ...(yield* readCheckout(root)),
    pr:
      found === undefined
        ? undefined
        : { number: found.number, headSha: found.headRefOid },
    gh: yield* stdoutOf("gh", ["--version"], { cwd: root }),
    dryRun,
  })
  if (unmet.length > 0)
    yield* Console.log(
      `--dry-run: a real run would refuse:\n${unmet.join("\n")}\n`
    )
  yield* Console.log(`Picked: ${specs.join(", ")}`)

  const results = path.join(root, "apps/e2e/test-results")
  const reportFile = path.join(results, "e2e-evidence-report.json")
  yield* fs.remove(reportFile, { force: true })
  // About a quarter of the cores, since the trace of every test is
  // the run's load, not the picked specs' video: on 16 cores, 8 workers timed
  // out account.spec.ts in 2 of 3 runs (one during a DNS outage) with no video
  // on it and finished no sooner than 4, which passed (apinrdw/kumora#210).
  const workers = Math.max(1, Math.floor(availableParallelism() / 4))
  const playwright = [
    "test:e2e",
    "--forbid-only",
    `--workers=${workers}`,
    // A failure keeps its trace, which a red run prints (apinrdw/kumora#207).
    "--trace=retain-on-failure",
    "--reporter=list,json",
  ]
  const exitCode = yield* runOnTerminal(
    ChildProcess.make("pnpm", playwright, {
      cwd: root,
      // The video switch, as apps/e2e/support/video.ts defines it: the picked
      // specs, comma-separated. A root script imports from no workspace, so
      // the two name each other.
      env: {
        E2E_VIDEO: specs.join(","),
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  )
  if (!(yield* fs.exists(reportFile)))
    return yield* new CommandFailed({
      command: ["pnpm", ...playwright].join(" "),
      exitCode,
      stderr: `It wrote no JSON report to ${path.relative(root, reportFile)}.`,
    })

  const report = yield* Schema.decodeEffect(
    Schema.fromJsonString(PlaywrightReport)
  )(yield* fs.readFileString(reportFile))
  const plan = yield* evidencePlan({
    specs,
    pr,
    exitCode,
    report,
    files: yield* listFiles(root, report),
    checkout: yield* readCheckout(root),
    dryRun,
  })
  if (plan.unmet.length > 0)
    yield* Console.log(
      `\n--dry-run: after the suite, a real run would refuse:\n${plan.unmet.join("\n")}`
    )

  // gh runs from each body file's folder, which the plan's video paths are
  // relative to.
  const commentArgs = (comment: EvidenceComment) => [
    "pr",
    "comment",
    String(plan.pr),
    "--body-file",
    path.basename(comment.bodyFile),
    ...comment.videos.flatMap((video) => ["--attach", video]),
  ]
  const status = (target: string) => [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/statuses/${plan.status.sha}`,
    "-f",
    `state=${plan.status.state}`,
    "-f",
    `context=${plan.status.context}`,
    "-f",
    `description=${plan.status.description}`,
    "-f",
    `target_url=${target}`,
  ]
  const count = plan.comments.length
  if (dryRun) {
    yield* Effect.forEach(
      plan.comments,
      (comment, at) =>
        Console.log(
          `\n--dry-run: would post part ${at + 1} of ${count} to PR #${plan.pr}:\n\n${comment.body}\nin ${path.dirname(comment.bodyFile)}: gh ${commentArgs(comment).join(" ")}`
        ),
      { discard: true }
    )
    yield* Console.log(`\ngh ${status("<part 1's comment URL>").join(" ")}`)
    return
  }
  const urls = yield* postEvidence(plan, {
    comment: (comment) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          path.join(root, comment.bodyFile),
          comment.body
        )
        return yield* commentUrl(
          yield* stdoutOf("gh", commentArgs(comment), {
            cwd: path.join(root, path.dirname(comment.bodyFile)),
          })
        )
      }),
    status: (target) =>
      Effect.asVoid(stdoutOf("gh", status(target), { cwd: root })),
  })
  const videos = plan.comments.reduce(
    (sum, comment) => sum + comment.videos.length,
    0
  )
  yield* Console.log(
    `Posted ${videos} videos in ${count} ${count === 1 ? "comment" : "comments"} (${urls.join(", ")}) and set ${plan.status.context} to ${plan.status.state} on ${plan.status.sha.slice(0, 10)}.`
  )
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* e2eEvidence(yield* repoRoot, args)
  })
)
