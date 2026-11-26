import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem } from "./lib/testing.mts"
import { checkVpVersion } from "./vp-version.mts"

const repo = (files: Record<string, string>) =>
  Layer.merge(memoryFileSystem(files), Path.layer)

const manifest = (devDependencies: Record<string, string>) =>
  JSON.stringify({ name: "kumora", devDependencies })

// A workflow with one job per entry, each set up by setup-vp at `version`.
const workflow = (jobs: Record<string, string>) =>
  [
    "jobs:",
    ...Object.entries(jobs).flatMap(([job, version]) => [
      `  ${job}:`,
      "    steps:",
      "      - uses: actions/checkout@v5",
      "      - uses: voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76",
      "        with:",
      `          version: ${version}`,
      "      - run: vp install --frozen-lockfile",
    ]),
  ].join("\n")

describe("checkVpVersion", () => {
  it.effect("passes when every setup-vp step names the pinned version", () =>
    Effect.gen(function* () {
      yield* checkVpVersion("/repo")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "vp 1.8.0 in package.json and 3 setup-vp steps.",
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/package.json": manifest({ "vite-plus": "1.8.0" }),
          "/repo/.github/workflows/ci.yml": workflow({
            static: "1.8.0",
            tests: '"1.8.0"',
          }),
          "/repo/.github/workflows/release.yml": workflow({
            release: "1.8.0",
          }),
          "/repo/.github/workflows/notes.md": "setup-vp version: 0.1.0",
        })
      )
    )
  )

  it.effect("fails naming each setup-vp step on another version or none", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(checkVpVersion("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.include(error.summary, "1.8.0")
      assert.deepStrictEqual(error.findings, [
        ".github/workflows/ci.yml tests: 1.7.2",
        ".github/workflows/teardown.yml destroy: no version",
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/package.json": manifest({ "vite-plus": "1.8.0" }),
          "/repo/.github/workflows/ci.yml": workflow({
            static: "1.8.0",
            tests: "1.7.2",
          }),
          "/repo/.github/workflows/teardown.yml": [
            "jobs:",
            "  destroy:",
            "    steps:",
            "      - uses: voidzero-dev/setup-vp@cab1ab9eaff52d4857875f4f2c016e36af8f2c76",
          ].join("\n"),
        })
      )
    )
  )

  it.effect("fails when the root pins no exact vite-plus version", () =>
    Effect.gen(function* () {
      const pins: ReadonlyArray<Record<string, string>> = [
        {},
        { "vite-plus": "^1.8.0" },
      ]
      for (const devDependencies of pins) {
        const error = yield* Effect.flip(
          checkVpVersion("/repo").pipe(
            Effect.provide(
              repo({
                "/repo/package.json": manifest(devDependencies),
                "/repo/.github/workflows/ci.yml": workflow({ static: "1.8.0" }),
              })
            )
          )
        )
        assert.instanceOf(error, CheckFailed)
        assert.include(error.summary, "exact vite-plus devDependency")
      }
    })
  )

  it.effect("fails when no workflow sets up vp with setup-vp", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(checkVpVersion("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.include(error.summary, "No workflow step uses setup-vp")
    }).pipe(
      Effect.provide(
        repo({
          "/repo/package.json": manifest({ "vite-plus": "1.8.0" }),
          "/repo/.github/workflows/ci.yml":
            "jobs:\n  static:\n    steps:\n      - uses: pnpm/action-setup@v6\n",
        })
      )
    )
  )
})
