import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestConsole } from "effect/testing"

import config from "../vite.config.ts"
import { CheckFailed } from "./lib/check.mts"
import { checkOxlintOverrides } from "./oxlint-overrides.mts"

const rootPaths = [
  { name: "cloudflare:workers", message: "Use WorkerEnv." },
  { name: "zod", message: "Use Schema." },
]
const rootPatterns = [{ group: ["**/repos/**", "repos/**"], message: "Ref." }]

const imports = (
  paths: ReadonlyArray<object>,
  patterns: ReadonlyArray<object>
) => ["error", { paths, patterns }]

// A lint block, as vite.config.ts holds it.
const check = (overrides: ReadonlyArray<object>) =>
  checkOxlintOverrides({
    rules: { "no-restricted-imports": imports(rootPaths, rootPatterns) },
    overrides,
  })

// The findings of a check that must fail with CheckFailed.
const findingsOf = (overrides: ReadonlyArray<object>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(check(overrides))
    if (!(error instanceof CheckFailed)) return assert.fail(String(error))
    return error.findings
  })

const fsBan = { regex: "^(node:)?fs(/.*)?$", message: "Use FileSystem." }

describe("checkOxlintOverrides", () => {
  it.effect("passes when each override restates the root bans", () =>
    Effect.gen(function* () {
      yield* check([
        {
          files: ["scripts/**"],
          rules: {
            "no-restricted-imports": imports(rootPaths, [
              ...rootPatterns,
              fsBan,
            ]),
          },
        },
        { files: ["apps/web/src/**"], rules: { "no-var": "error" } },
      ])
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 overrides, each restates the root import bans.",
      ])
    })
  )

  it.effect("fails naming a root path an override omits", () =>
    Effect.gen(function* () {
      const findings = yield* findingsOf([
        {
          files: ["scripts/**"],
          rules: {
            "no-restricted-imports": imports([rootPaths[0]], rootPatterns),
          },
        },
      ])
      assert.deepStrictEqual(findings, [
        'overrides[0] (scripts/**): missing path "zod"',
      ])
    })
  )

  it.effect("fails naming a root pattern an override omits", () =>
    Effect.gen(function* () {
      const findings = yield* findingsOf([
        {
          files: ["scripts/**"],
          rules: { "no-restricted-imports": imports(rootPaths, [fsBan]) },
        },
      ])
      assert.deepStrictEqual(findings, [
        'overrides[0] (scripts/**): missing pattern group ["**/repos/**","repos/**"]',
      ])
    })
  )

  it.effect("fails on an override that sets the rule without options", () =>
    Effect.gen(function* () {
      const findings = yield* findingsOf([
        { files: ["scripts/**"], rules: { "no-restricted-imports": "off" } },
      ])
      assert.deepStrictEqual(findings, [
        "overrides[0] (scripts/**): sets no-restricted-imports without the root paths and patterns",
      ])
    })
  )

  it.effect("only the bridge may omit cloudflare:workers", () =>
    Effect.gen(function* () {
      const withoutWorkers = {
        "no-restricted-imports": imports([rootPaths[1]], rootPatterns),
      }
      const findings = yield* findingsOf([
        { files: ["packages/server/src/bridge.ts"], rules: withoutWorkers },
        { files: ["packages/server/src/**"], rules: withoutWorkers },
      ])
      assert.deepStrictEqual(findings, [
        'overrides[1] (packages/server/src/**): missing path "cloudflare:workers"',
      ])
    })
  )

  it.effect("the repo's lint config restates the root bans everywhere", () =>
    checkOxlintOverrides(config.lint)
  )
})
