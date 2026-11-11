// Lints snippets against the real .oxlintrc.json. Fixtures can't live in the
// repo (they would fail lint), so each run copies the config and its plugin
// into a temporary root and writes the snippet at the path under test.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"

import { CommandFailed, collect } from "./lib/command.mts"

const Report = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        help: Schema.optional(Schema.String),
      })
    ),
  })
)

const lint = Effect.fnUntraced(function* (file: string, source: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "..")
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lint-bans-" })
  for (const copied of [".oxlintrc.json", "scripts/oxlint-plugin.mts"]) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, copied)), {
      recursive: true,
    })
    yield* fs.copyFile(path.join(root, copied), path.join(dir, copied))
  }
  yield* fs.makeDirectory(path.dirname(path.join(dir, file)), {
    recursive: true,
  })
  yield* fs.writeFileString(path.join(dir, file), source)
  const oxlint = path.join(root, "node_modules/.bin/oxlint")
  const args = ["--disable-nested-config", "--format=json", file]
  const result = yield* collect(ChildProcess.make(oxlint, args, { cwd: dir }))
  if (result.stdout === "")
    return yield* new CommandFailed({
      command: ["oxlint", ...args].join(" "),
      exitCode: result.exitCode,
      stderr: result.stderr,
    })
  const { diagnostics } = yield* Schema.decodeEffect(Report)(result.stdout)
  return diagnostics.map(({ code, message, help }) =>
    `${code}: ${message} ${help ?? ""}`.trim()
  )
})

const lintScript = (source: string) => lint("scripts/fixture.mts", source)

// Asserts one diagnostic from `rule` whose text names `fix`.
const assertBanned = (
  diagnostics: ReadonlyArray<string>,
  rule: string,
  fix: string
) =>
  assert.isTrue(
    diagnostics.some((line) => line.startsWith(rule) && line.includes(fix)),
    `no ${rule} naming ${fix} in:\n${diagnostics.join("\n")}`
  )

layer(NodeServices.layer)("Effect lint bans under scripts/", (it) => {
  it.effect("a clean Effect program lints clean", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        [
          'import { Effect } from "effect"',
          "",
          "export const wait = (p: Promise<number>): Effect.Effect<number> =>",
          "  Effect.promise(() => p)",
          "",
        ].join("\n")
      )
      assert.deepStrictEqual(diagnostics, [])
    })
  )

  it.effect("throw names Effect.fail", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        'export const f = () => {\n  throw new Error("boom")\n}\n'
      )
      assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
    })
  )

  it.effect("async is rejected; CODING_STANDARDS.md names Effect.gen", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        "export const f = async () => 1\nexport async function g() {}\n"
      )
      assertBanned(diagnostics, "oxc(no-async-await)", "async")
      assert.strictEqual(
        diagnostics.filter((line) => line.startsWith("oxc(no-async-await)"))
          .length,
        2
      )
    })
  )

  it.effect("new Promise and Promise.all name Effect.promise", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        "export const p = new Promise(() => {})\nexport const q = Promise.all([])\n"
      )
      assert.strictEqual(
        diagnostics.filter(
          (line) =>
            line.startsWith("eslint(no-restricted-globals)") &&
            line.includes("Effect.promise")
        ).length,
        2
      )
    })
  )

  it.effect("process.exit names the failing Effect", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript("process.exit(1)\n")
      assertBanned(
        diagnostics,
        "eslint(no-restricted-properties)",
        "tagged error"
      )
    })
  )

  it.effect("globalThis.process.exit names the failing Effect", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript("globalThis.process.exit(1)\n")
      assertBanned(diagnostics, "kumora(restricted-syntax)", "tagged error")
    })
  )

  it.effect("process.env names Config", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        "export const token = process.env.TOKEN\n"
      )
      assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
    })
  )

  it.effect.each([
    ['import { readFileSync } from "node:fs"', "FileSystem"],
    ['import { readFile } from "node:fs/promises"', "FileSystem"],
    ['import fs from "fs"', "FileSystem"],
    ['import { spawn } from "node:child_process"', "ChildProcess"],
    ['import { exec } from "child_process"', "ChildProcess"],
  ])("%s names %s", ([line, fix]) =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(`${line}\n\nexport { line }\n`)
      assertBanned(diagnostics, "eslint(no-restricted-imports)", fix)
    })
  )

  it.effect("the root import bans still apply", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lintScript(
        'import { z } from "zod"\nimport { Schema } from "@effect/schema"\n\nexport { z, Schema }\n'
      )
      assertBanned(
        diagnostics,
        "eslint(no-restricted-imports)",
        "Effect Schema"
      )
      assertBanned(diagnostics, "eslint(no-restricted-imports)", "v3")
    })
  )
})

layer(NodeServices.layer)("packages/ui/src is exempt", (it) => {
  it.effect("shadcn-style code with throw, async and Promise lints clean", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "packages/ui/src/components/thing.tsx",
        [
          "export async function load(): Promise<number> {",
          '  if (Math.random() > 2) throw new Error("never")',
          "  return Promise.resolve(process.env.X ? 1 : 0)",
          "}",
          "",
        ].join("\n")
      )
      assert.deepStrictEqual(diagnostics, [])
    })
  )

  it.effect("it keeps the root import bans", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "packages/ui/src/lib/schema.ts",
        'import { z } from "zod"\n\nexport { z }\n'
      )
      assertBanned(
        diagnostics,
        "eslint(no-restricted-imports)",
        "Effect Schema"
      )
    })
  )
})

layer(NodeServices.layer)("packages/server is under the full ban set", (it) => {
  it.effect.each([
    ["packages/server/src/thing.ts"],
    ["packages/server/tests/thing.test.ts"],
  ])("throw and async in %s are rejected", ([file]) =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        file,
        'export const f = async () => {\n  throw new Error("boom")\n}\n'
      )
      assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
      assertBanned(diagnostics, "oxc(no-async-await)", "async")
    })
  )

  it.effect("the bridge may import cloudflare:workers", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "packages/server/src/bridge.ts",
        'import { env } from "cloudflare:workers"\n\nexport { env }\n'
      )
      assert.deepStrictEqual(diagnostics, [])
    })
  )

  it.effect("the bridge keeps the other bans", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "packages/server/src/bridge.ts",
        [
          'import { readFileSync } from "node:fs"',
          'import { z } from "zod"',
          "",
          "export { readFileSync, z }",
          "export const f = () => {",
          '  throw new Error("boom")',
          "}",
          "",
        ].join("\n")
      )
      assertBanned(diagnostics, "eslint(no-restricted-imports)", "FileSystem")
      assertBanned(
        diagnostics,
        "eslint(no-restricted-imports)",
        "Effect Schema"
      )
      assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
    })
  )

  it.effect(
    "the rest of packages/server may not import cloudflare:workers",
    () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "packages/server/src/errors.ts",
          'import { env } from "cloudflare:workers"\n\nexport { env }\n'
        )
        assertBanned(diagnostics, "eslint(no-restricted-imports)", "WorkerEnv")
      })
  )
})

layer(NodeServices.layer)("packages/deploy is under the full ban set", (it) => {
  const envAndExit = [
    "export const swap = () => {",
    "  delete process.env.CLOUDFLARE_API_TOKEN",
    "  process.exit(1)",
    "}",
    "",
  ].join("\n")

  it.effect("deploy code may not touch process.env or child_process", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "packages/deploy/tests/deploy.test.ts",
        [
          'import { spawn } from "node:child_process"',
          "",
          "export { spawn }",
          envAndExit,
        ].join("\n")
      )
      assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
      assertBanned(diagnostics, "eslint(no-restricted-imports)", "ChildProcess")
    })
  )

  it.effect.each([
    "packages/deploy/src/token-swap.ts",
    "packages/deploy/tests/token-swap.test.ts",
  ])("%s may write process.env but not exit", (file) =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(file, envAndExit)
      assert.isFalse(
        diagnostics.some((line) => line.includes("Config")),
        diagnostics.join("\n")
      )
      assertBanned(diagnostics, "eslint(no-restricted-properties)", "runMain")
    })
  )
})

layer(NodeServices.layer)("apps/web is under the Effect bans", (it) => {
  it.effect.each([
    ["apps/web/alchemy.run.ts"],
    ["apps/web/src/router.tsx"],
    ["apps/web/src/server/thing.ts"],
    ["apps/web/src/start.ts"],
  ])("throw and async in %s are rejected", ([file]) =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        file,
        'export const f = async () => {\n  throw new Error("boom")\n}\n'
      )
      assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
      assertBanned(diagnostics, "oxc(no-async-await)", "async")
    })
  )

  it.effect("an async loader in a route is rejected", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "apps/web/src/routes/thing.tsx",
        "export const loader = async () => 1\n"
      )
      assertBanned(diagnostics, "oxc(no-async-await)", "async")
    })
  )

  it.effect("a route may throw redirect or notFound", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "apps/web/src/routes/thing.tsx",
        [
          'import { notFound } from "@tanstack/react-router"',
          "",
          "export const beforeLoad = () => {",
          "  throw notFound()",
          "}",
          "",
        ].join("\n")
      )
      assert.deepStrictEqual(diagnostics, [])
    })
  )

  it.effect("a route keeps the other bans", () =>
    Effect.gen(function* () {
      const diagnostics = yield* lint(
        "apps/web/src/routes/thing.tsx",
        [
          'import { readFileSync } from "node:fs"',
          'import { z } from "zod"',
          "",
          "export { readFileSync, z }",
          "export const all = Promise.all([])",
          "export const env = process.env.X",
          "export const exit = () => globalThis.process.exit(1)",
          "",
        ].join("\n")
      )
      assertBanned(diagnostics, "eslint(no-restricted-imports)", "FileSystem")
      assertBanned(
        diagnostics,
        "eslint(no-restricted-imports)",
        "Effect Schema"
      )
      assertBanned(
        diagnostics,
        "eslint(no-restricted-globals)",
        "Effect.promise"
      )
      assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
      assertBanned(diagnostics, "kumora(restricted-syntax)", "Config")
    })
  )
})

layer(NodeServices.layer)(
  "apps/dashboard's non-component code is under the full ban set",
  (it) => {
    it.effect.each([
      ["apps/dashboard/alchemy.run.ts"],
      ["apps/dashboard/src/domain/thing.ts"],
      ["apps/dashboard/src/lib/thing.ts"],
      ["apps/dashboard/src/server/auth/thing.ts"],
      ["apps/dashboard/src/worker.ts"],
      ["apps/dashboard/src/components/k/thing.ts"],
      ["apps/dashboard/tests/lib/thing.test.ts"],
      ["apps/dashboard/tests/server/thing.test.ts"],
      ["apps/dashboard/tests/components/k/thing.test.ts"],
    ])("throw and async in %s are rejected", ([file]) =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          file,
          'export const f = async () => {\n  throw new Error("boom")\n}\n'
        )
        assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
        assertBanned(diagnostics, "oxc(no-async-await)", "async")
      })
    )

    it.effect("a dashboard lib function keeps the other bans", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/lib/thing.ts",
          [
            'import { readFileSync } from "node:fs"',
            "",
            "export { readFileSync }",
            "export const all = Promise.all([])",
            "export const env = process.env.X",
            "",
          ].join("\n")
        )
        assertBanned(diagnostics, "eslint(no-restricted-imports)", "FileSystem")
        assertBanned(
          diagnostics,
          "eslint(no-restricted-globals)",
          "Effect.promise"
        )
        assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
      })
    )
  }
)

layer(NodeServices.layer)(
  "apps/dashboard's React code is under the bans, throw allowed in routes",
  (it) => {
    it.effect.each([
      ["apps/dashboard/src/router.tsx"],
      ["apps/dashboard/src/components/k/thing.tsx"],
      ["apps/dashboard/src/components/market-live/thing.tsx"],
      ["apps/dashboard/tests/components/k/thing.test.tsx"],
      ["apps/dashboard/tests/support/thing.tsx"],
    ])("throw and async in %s are rejected", ([file]) =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          file,
          'export const f = async () => {\n  throw new Error("boom")\n}\n'
        )
        assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
        assertBanned(diagnostics, "oxc(no-async-await)", "async")
      })
    )

    it.effect("an async event handler in a component is rejected", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/components/account/thing.tsx",
          [
            "export function Thing() {",
            "  const save = async () => {}",
            "  return <button onClick={() => void save()}>Save</button>",
            "}",
            "",
          ].join("\n")
        )
        assertBanned(diagnostics, "oxc(no-async-await)", "async")
      })
    )

    it.effect("an async loader in a route is rejected", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/routes/_app/thing.tsx",
          "export const loader = async () => 1\n"
        )
        assertBanned(diagnostics, "oxc(no-async-await)", "async")
      })
    )

    it.effect("a route may throw redirect or notFound", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/routes/_app/thing.tsx",
          [
            'import { notFound, redirect } from "@tanstack/react-router"',
            "",
            "export const beforeLoad = (signedIn: boolean) => {",
            '  if (!signedIn) throw redirect({ to: "/sign-in" })',
            "  throw notFound()",
            "}",
            "",
          ].join("\n")
        )
        assert.deepStrictEqual(diagnostics, [])
      })
    )

    it.effect("a route keeps the other bans", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/routes/thing.tsx",
          [
            'import { readFileSync } from "node:fs"',
            "",
            "export { readFileSync }",
            "export const all = Promise.all([])",
            "export const env = process.env.X",
            "export const exit = () => globalThis.process.exit(1)",
            "",
          ].join("\n")
        )
        assertBanned(diagnostics, "eslint(no-restricted-imports)", "FileSystem")
        assertBanned(
          diagnostics,
          "eslint(no-restricted-globals)",
          "Effect.promise"
        )
        assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
        assertBanned(diagnostics, "kumora(restricted-syntax)", "Config")
      })
    )

    it.effect("a component may throw nothing, a route's throw included", () =>
      Effect.gen(function* () {
        const diagnostics = yield* lint(
          "apps/dashboard/src/components/thing.tsx",
          [
            'import { notFound } from "@tanstack/react-router"',
            "",
            "export const missing = () => {",
            "  throw notFound()",
            "}",
            "",
          ].join("\n")
        )
        assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
      })
    )
  }
)
