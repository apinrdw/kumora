// `pnpm e2e:evidence [--pr <n>] [--dry-run] [spec...]`: runs the full e2e
// suite with video on, posts the picked specs' videos to the PR as one comment
// and marks the PR head `e2e-evidence: success`, linking to it. Every decision
// is in scripts/e2e-evidence-plan.mts; this file runs git, gh and Playwright.
// --dry-run prints the comment and the gh calls instead of making them.
import { availableParallelism } from "node:os"
import { parseArgs as parseCliArgs } from "node:util"

import { ByteSize, Console, Effect, FileSystem, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  commentUrl,
  evidencePlan,
  preflight,
  resultsFolders,
  PlaywrightReport,
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
  // Decision: changed specs are diffed from the merge base with the PR's base
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
    dirty: yield* gitLines(root, ["status", "--porcelain"]),
    head: (yield* stdoutOf("git", ["rev-parse", "HEAD"], { cwd: root })).trim(),
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
  // Decision: about a quarter of the cores, since every page records through
  // its own VP9 encoder: 8 workers with video timed out on 16 cores, 4 passed
  // (apinrdw/kumora#210).
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
      // The video switch, as apps/e2e/support/video.ts defines it; a root
      // script imports from no workspace, so the two name each other.
      env: { E2E_VIDEO: "on", PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
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
  })

  yield* fs.writeFileString(path.join(root, plan.bodyFile), plan.body)
  // gh runs from the body file's folder, which the plan's video paths are
  // relative to.
  const commentDir = path.dirname(plan.bodyFile)
  const comment = [
    "pr",
    "comment",
    String(plan.pr),
    "--body-file",
    path.basename(plan.bodyFile),
    ...plan.videos.flatMap((video) => ["--attach", video]),
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
  if (dryRun) {
    yield* Console.log(
      `\n--dry-run: would post this to PR #${plan.pr}:\n\n${plan.body}\nin ${commentDir}: gh ${comment.join(" ")}\ngh ${status("<comment URL>").join(" ")}`
    )
    return
  }
  const url = yield* commentUrl(
    yield* stdoutOf("gh", comment, { cwd: path.join(root, commentDir) })
  )
  yield* stdoutOf("gh", status(url), { cwd: root })
  yield* Console.log(
    `Posted ${plan.videos.length} videos to ${url} and set ${plan.status.context} to ${plan.status.state} on ${plan.status.sha.slice(0, 10)}.`
  )
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* e2eEvidence(yield* repoRoot, args)
  })
)
