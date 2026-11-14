import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"

import { collect } from "./lib/command.mts"

// Runs the hook on `command` with a fake gh that records its arguments and
// answers `gh pr checks` with `checks`.
const runGate = Effect.fnUntraced(function* (command: string, checks: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "merge-gate-test-" })
  const args = path.join(dir, "args")
  yield* fs.writeFileString(path.join(dir, "checks.json"), checks)
  yield* fs.writeFileString(
    path.join(dir, "gh"),
    `#!/bin/sh\necho "$@" > "${args}"\ncat "${dir}/checks.json"\nexit 8\n`
  )
  yield* fs.chmod(path.join(dir, "gh"), 0o755)
  const inheritedPath = yield* Config.String("PATH")
  const gate = path.resolve(
    import.meta.dirname,
    "../.claude/hooks/merge-gate.sh"
  )
  const result = yield* collect(
    ChildProcess.make("bash", [gate], {
      stdin: Stream.make(
        new TextEncoder().encode(
          JSON.stringify({ cwd: dir, tool_input: { command } })
        )
      ),
      env: { PATH: `${dir}:${inheritedPath}` },
      extendEnv: true,
    })
  )
  const asked = (yield* fs.exists(args))
    ? (yield* fs.readFileString(args)).trim()
    : undefined
  return { ...result, asked }
})

const check = (name: string, bucket: string) => ({ name, bucket })

// PR #291's checks when its triage session ran `gh pr merge --auto`: the
// no-e2e-evidence label had passed the only required check, so it merged.
const pr291 = JSON.stringify([
  check("Workers Builds: kumora-dashboard-builds", "pending"),
  check("e2e-evidence gate", "pass"),
  check("fallow", "pending"),
  check("static", "pending"),
  check("unit-tests", "pending"),
  check("e2e-evidence", "pass"),
])

layer(NodeServices.layer)("merge gate hook", (it) => {
  it.effect("pending checks block the merge, --auto included", () =>
    Effect.gen(function* () {
      const { exitCode, stderr, asked } = yield* runGate(
        "gh pr merge 291 --auto --merge 2>&1; gh pr view 291 --json autoMergeRequest -q .autoMergeRequest",
        pr291
      )
      assert.strictEqual(exitCode, 2)
      assert.strictEqual(asked, "pr checks 291 --json name,bucket")
      assert.match(stderr, /pending: static/)
      assert.match(stderr, /nothing in this command ran/)
      assert.notInclude(stderr, "e2e-evidence gate")
    })
  )

  it.effect("a failed check blocks the merge", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* runGate(
        'git push && gh pr merge --merge --subject "Fix 12 things"',
        JSON.stringify([check("static", "pass"), check("fallow", "fail")])
      )
      assert.strictEqual(exitCode, 2)
      assert.match(stderr, /fail: fallow/)
    })
  )

  it.effect("with no number, gh is asked about the current branch's PR", () =>
    Effect.gen(function* () {
      const { asked } = yield* runGate(
        'gh pr merge --merge --subject "Fix 12 things"',
        "[]"
      )
      assert.strictEqual(asked, "pr checks --json name,bucket")
    })
  )

  it.effect("a --repo and a branch name reach gh", () =>
    Effect.gen(function* () {
      const { asked } = yield* runGate(
        "gh pr merge -R apinrdw/kumora --squash feat/x",
        "[]"
      )
      assert.strictEqual(
        asked,
        "pr checks --repo apinrdw/kumora feat/x --json name,bucket"
      )
    })
  )

  it.effect("passed and skipped checks allow the merge", () =>
    Effect.gen(function* () {
      const { exitCode } = yield* runGate(
        "gh pr merge https://github.com/apinrdw/kumora/pull/291 --merge",
        JSON.stringify([check("static", "pass"), check("stage", "skipping")])
      )
      assert.strictEqual(exitCode, 0)
    })
  )

  it.effect("a command that merges nothing never asks gh", () =>
    Effect.gen(function* () {
      const { exitCode, asked } = yield* runGate("gh pr view 291", pr291)
      assert.strictEqual(exitCode, 0)
      assert.isUndefined(asked)
    })
  )

  it.effect("no answer from gh allows the merge with a notice", () =>
    Effect.gen(function* () {
      const { exitCode, stderr } = yield* runGate(
        "gh pr merge 291",
        "no checks reported on the 'x' branch"
      )
      assert.strictEqual(exitCode, 0)
      assert.match(stderr, /no answer/)
    })
  )
})
