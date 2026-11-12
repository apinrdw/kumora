// `pnpm e2e:evidence [--pr <n>] [--dry-run] <spec...>`: runs the full e2e
// suite with video on, posts the named specs' videos to the PR as one comment
// and marks the PR head `e2e-evidence: success`, linking to it. Every decision
// is in scripts/e2e-evidence-plan.mts; this file runs gh and Playwright.
// --dry-run prints the comment and the gh calls instead of making them.
import { availableParallelism } from "node:os"
import { parseArgs as parseCliArgs } from "node:util"

import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  commentUrl,
  evidencePlan,
  resultsFolders,
  PlaywrightReport,
} from "./e2e-evidence-plan.mts"
import { CheckFailed, repoRoot } from "./lib/check.mts"
import { CommandFailed, stdoutOf } from "./lib/command.mts"
import { runScript } from "./lib/run.mts"

const USAGE = "Usage: pnpm e2e:evidence [--pr <n>] [--dry-run] <spec...>"

const Pr = Schema.fromJsonString(
  Schema.Struct({ number: Schema.Number, headRefOid: Schema.String })
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

// Runs a command on this terminal and returns its exit code.
const attached = Effect.fn("attached")(function* (
  command: ChildProcess.Command
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(command)
  return yield* handle.exitCode
}, Effect.scoped)

// Each results folder the report names, to the repo-relative .webm files in
// it. A test that opens no page may leave no folder.
const listVideos = Effect.fnUntraced(function* (
  root: string,
  report: typeof PlaywrightReport.Type
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* Effect.forEach(
    yield* resultsFolders(report),
    (folder) =>
      Effect.map(
        Effect.orElseSucceed(fs.readDirectory(folder), () => []),
        (names) =>
          [
            folder,
            names
              .filter((name) => name.endsWith(".webm"))
              .map((name) => path.relative(root, path.join(folder, name))),
          ] as const
      )
  )
  return new Map(listed)
})

const e2eEvidence = Effect.fn("e2eEvidence")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { specs, pr: prArg, dryRun } = yield* parseArgs(args)

  const pr = yield* Schema.decodeEffect(Pr)(
    yield* stdoutOf(
      "gh",
      ["pr", "view", ...(prArg ? [prArg] : []), "--json", "number,headRefOid"],
      { cwd: root }
    )
  )

  const results = path.join(root, "apps/e2e/test-results")
  const reportFile = path.join(results, "e2e-evidence-report.json")
  // Decision: about a quarter of the cores, since every page records through
  // its own VP9 encoder: 8 workers with video timed out on 16 cores, 4 passed
  // (apinrdw/kumora#210).
  const workers = Math.max(1, Math.floor(availableParallelism() / 4))
  const playwright = [
    "test:e2e",
    "--forbid-only",
    `--workers=${workers}`,
    "--reporter=list,json",
  ]
  const exitCode = yield* attached(
    ChildProcess.make("pnpm", playwright, {
      cwd: root,
      env: { E2E_VIDEO: "on", PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  )
  if (exitCode !== 0)
    return yield* new CommandFailed({
      command: ["pnpm", ...playwright].join(" "),
      exitCode,
      stderr: "",
    })

  const report = yield* Schema.decodeEffect(
    Schema.fromJsonString(PlaywrightReport)
  )(yield* fs.readFileString(reportFile))
  const plan = yield* evidencePlan({
    specs,
    pr: { number: pr.number, headSha: pr.headRefOid },
    report,
    videos: yield* listVideos(root, report),
  })

  const bodyFile = path.join(results, "e2e-evidence.md")
  yield* fs.writeFileString(bodyFile, plan.body)
  const comment = [
    "pr",
    "comment",
    String(plan.pr),
    "--body-file",
    path.relative(root, bodyFile),
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
      `\n--dry-run: would post this to PR #${plan.pr}:\n\n${plan.body}\ngh ${comment.join(" ")}\ngh ${status("<comment URL>").join(" ")}`
    )
    return
  }
  const url = yield* commentUrl(yield* stdoutOf("gh", comment, { cwd: root }))
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
