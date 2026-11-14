import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"

import { collect } from "./lib/command.mts"

// Writes an executable sh script that touches `marker` and prints `body`.
const fakeBinary = Effect.fnUntraced(function* (file: string, body: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(file, `#!/bin/sh\n${body}`)
  yield* fs.chmod(file, 0o755)
})

// Runs the hook with `pathDirs` ahead of the inherited PATH, from `cwd`.
const runHook = Effect.fnUntraced(function* (
  cwd: string,
  command: string,
  pathDirs: ReadonlyArray<string>
) {
  const path = yield* Path.Path
  const inheritedPath = yield* Config.String("PATH")
  const gate = path.resolve(
    import.meta.dirname,
    "../.claude/hooks/fallow-gate.sh"
  )
  const input = JSON.stringify({ cwd, tool_input: { command } })
  return yield* collect(
    ChildProcess.make("bash", [gate], {
      stdin: Stream.make(new TextEncoder().encode(input)),
      env: { PATH: [...pathDirs, inheritedPath].join(":"), TMPDIR: cwd },
      extendEnv: true,
    })
  )
})

const runGate = Effect.fnUntraced(function* (
  command: string,
  report: string,
  exitCode = 0
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fallow-gate-test-" })
  const called = path.join(dir, "called")
  yield* fs.writeFileString(path.join(dir, "report.json"), report)
  yield* fakeBinary(
    path.join(dir, "fallow"),
    `touch "${called}"\ncat "${dir}/report.json"\nexit ${exitCode}\n`
  )
  const result = yield* runHook(dir, command, [dir])
  return { ...result, audited: yield* fs.exists(called) }
})

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

layer(NodeServices.layer)("fallow gate hook", (it) => {
  it.effect(
    "a failing audit blocks with a summary and keeps the full report on disk",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { exitCode, stderr } = yield* runGate(
          'git commit -m "x"',
          hugeFailure,
          1
        )
        assert.strictEqual(exitCode, 2)
        assert.isBelow(stderr.length, 8192, `stderr was ${stderr.length} bytes`)
        assert.match(stderr, /parseRow/)
        const reportPath = stderr.match(/Full report: (\S+)/)?.[1]
        assert.isDefined(reportPath)
        assert.strictEqual(yield* fs.readFileString(reportPath), hugeFailure)
      })
  )

  // Spec #263's #266 implementer hand-wrote jq five times to find what blocked:
  // the one error came 19th, after 18 warnings, cut before its severity.
  it.effect(
    "the blocking findings come first, whole, and the refusal says nothing ran",
    () =>
      Effect.gen(function* () {
        const warning = (name: string) => ({
          path: "apps/dashboard/src/components/market-live/footprint-canvas.tsx",
          name,
          line: 276,
          cyclomatic: 13,
          cognitive: 15,
          line_count: 67,
          param_count: 8,
          exceeded: "crap",
          severity: "critical",
          effective_severity: "warn",
          crap: 182,
          coverage_tier: "none",
          coverage_source: "estimated",
          introduced: true,
        })
        const blocker = {
          ...warning("MarketLiveDay"),
          path: "apps/dashboard/src/routes/_app/market-live.tsx",
          react_hook_count: 12,
          react_jsx_max_depth: 5,
          exceeded: "cognitive_crap",
          effective_severity: "error",
        }
        const report = JSON.stringify({
          verdict: "fail",
          complexity: {
            findings: [
              ...Array.from({ length: 18 }, (_, i) => warning(`cells${i}`)),
              blocker,
            ],
          },
        })
        const { exitCode, stderr } = yield* runGate(
          'sed -i s/a/b/ x.ts && git commit -m "x"',
          report,
          1
        )
        assert.strictEqual(exitCode, 2)
        assert.match(stderr, /nothing in this command ran/)
        assert.match(
          stderr.split("\n").find((line) => /cells/.test(line)) ?? "",
          /warn/
        )
        const block = stderr.indexOf("MarketLiveDay")
        assert.isAtLeast(block, 0)
        assert.isBelow(block, stderr.indexOf("cells0"))
        assert.match(stderr.slice(block - 200, block + 200), /cognitive_crap/)
      })
  )

  // Spec #280's review fixer was blocked five times on one unused export: the
  // summary dropped the finding's fix and the report's trace command, so it
  // guessed at type-only re-exports instead of removing the `export`.
  it.effect(
    "each finding names its fix, and the report's next steps are printed",
    () =>
      Effect.gen(function* () {
        const report = JSON.stringify({
          verdict: "fail",
          dead_code: {
            unused_exports: [
              {
                path: "packages/relay/src/broker-codes.ts",
                export_name: "InvestorType",
                is_type_only: false,
                line: 72,
                col: 13,
                span_start: 3108,
                is_re_export: false,
                finding_id: "dc1:unused-export:c3412d1803e394e2",
                actions: [
                  {
                    type: "remove-export",
                    auto_fixable: true,
                    description: "Remove the unused export from the public API",
                  },
                  {
                    type: "suppress-line",
                    auto_fixable: false,
                    description:
                      "Suppress with an inline comment above the line",
                    comment: "// fallow-ignore-next-line unused-export",
                  },
                ],
                introduced: true,
                effective_severity: "error",
              },
            ],
          },
          next_steps: [
            {
              id: "trace-unused-export",
              command:
                "fallow dead-code --trace packages/relay/src/broker-codes.ts:InvestorType",
              reason: "verify an export is truly unused before deleting",
            },
          ],
        })
        const { exitCode, stderr } = yield* runGate(
          'git commit -m "x"',
          report,
          1
        )
        assert.strictEqual(exitCode, 2)
        assert.match(
          stderr.split("\n").find((line) => /InvestorType/.test(line)) ?? "",
          /Remove the unused export/
        )
        assert.include(
          stderr,
          "fallow dead-code --trace packages/relay/src/broker-codes.ts:InvestorType"
        )
        assert.notInclude(stderr, "fallow-ignore")
      })
  )

  it.effect("git options before the subcommand still reach the audit", () =>
    Effect.gen(function* () {
      const { exitCode } = yield* runGate("git -C /tmp push", hugeFailure, 1)
      assert.strictEqual(exitCode, 2)
    })
  )

  it.effect("a passing audit allows the commit", () =>
    Effect.gen(function* () {
      const { exitCode, audited } = yield* runGate(
        'git commit -m "x"',
        JSON.stringify({ verdict: "pass" })
      )
      assert.strictEqual(exitCode, 0)
      assert.isTrue(audited)
    })
  )

  it.effect("a command that writes nothing to git skips the audit", () =>
    Effect.gen(function* () {
      const { exitCode, audited } = yield* runGate(
        "git log commit.txt",
        hugeFailure,
        1
      )
      assert.strictEqual(exitCode, 0)
      assert.isFalse(audited)
    })
  )

  it.effect(
    "an audit that gives no verdict allows the command with a notice",
    () =>
      Effect.gen(function* () {
        const { exitCode, stderr } = yield* runGate(
          'git commit -m "x"',
          "not json",
          2
        )
        assert.strictEqual(exitCode, 0)
        assert.match(stderr, /exited 2 without a verdict/)
      })
  )

  it.effect("the repo's pinned fallow wins over one on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "fallow-gate-test-",
      })
      const pass = `echo '{"verdict":"pass"}'\n`
      const bin = path.join(dir, "node_modules", ".bin")
      yield* fs.makeDirectory(bin, { recursive: true })
      yield* fakeBinary(
        path.join(bin, "fallow"),
        `touch "${path.join(dir, "pinned-ran")}"\n${pass}`
      )
      const global = path.join(dir, "global")
      yield* fs.makeDirectory(global)
      yield* fakeBinary(
        path.join(global, "fallow"),
        `touch "${path.join(dir, "global-ran")}"\n${pass}`
      )
      const { exitCode } = yield* runHook(dir, "git commit", [global])
      assert.strictEqual(exitCode, 0)
      assert.isTrue(yield* fs.exists(path.join(dir, "pinned-ran")))
      assert.isFalse(yield* fs.exists(path.join(dir, "global-ran")))
    })
  )
})
