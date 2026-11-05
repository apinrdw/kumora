import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const gate = resolve(import.meta.dirname, "../.claude/hooks/fallow-gate.sh")

const runGate = (command: string, report: string, exitCode = 0) => {
  const dir = mkdtempSync(join(tmpdir(), "fallow-gate-test-"))
  const called = join(dir, "called")
  writeFileSync(join(dir, "report.json"), report)
  const fake = join(dir, "fallow")
  writeFileSync(
    fake,
    `#!/bin/sh\ntouch "${called}"\ncat "${dir}/report.json"\nexit ${exitCode}\n`
  )
  chmodSync(fake, 0o755)
  const result = spawnSync("bash", [gate], {
    input: JSON.stringify({ cwd: dir, tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir },
  })
  return { ...result, audited: spawnSync("test", ["-e", called]).status === 0 }
}

const hugeFailure = JSON.stringify({
  verdict: "fail",
  attribution: { complexity_introduced: 1, duplication_inherited: 1 },
  complexity: {
    findings: [
      {
        path: "src/csv.ts",
        name: "parseRow",
        cyclomatic: 31,
        introduced: true,
      },
    ],
  },
  duplication: {
    clone_groups: [{ introduced: false, instances: ["x".repeat(3_000_000)] }],
  },
})

test("a failing audit blocks with a summary and keeps the full report on disk", () => {
  const { status, stderr } = runGate('git commit -m "x"', hugeFailure, 1)
  assert.equal(status, 2)
  assert.ok(stderr.length < 8192, `stderr was ${stderr.length} bytes`)
  assert.match(stderr, /parseRow/)
  const reportPath = stderr.match(/Full report: (\S+)/)?.[1]
  assert.ok(reportPath)
  assert.equal(readFileSync(reportPath, "utf8"), hugeFailure)
})

test("git options before the subcommand still reach the audit", () => {
  assert.equal(runGate("git -C /tmp push", hugeFailure, 1).status, 2)
})

test("a passing audit allows the commit", () => {
  const { status, audited } = runGate(
    'git commit -m "x"',
    JSON.stringify({ verdict: "pass" })
  )
  assert.equal(status, 0)
  assert.ok(audited)
})

test("a command that writes nothing to git skips the audit", () => {
  const { status, audited } = runGate("git log commit.txt", hugeFailure, 1)
  assert.equal(status, 0)
  assert.equal(audited, false)
})

test("an audit that gives no verdict allows the command with a notice", () => {
  const { status, stderr } = runGate('git commit -m "x"', "not json", 2)
  assert.equal(status, 0)
  assert.match(stderr, /exited 2 without a verdict/)
})
