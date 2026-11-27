// Lints snippets with `vp lint` against the lint block of the real root
// vite.config.ts. Fixtures can't live in the repo (they would fail lint), so
// each one gets a case directory of its own in a temporary root, holding the
// snippet at the path under test. Several cases share a path, so one case
// directory can't hold them. vp applies only the config at the root it runs
// from, so the temporary root gets the repo's lint block with every glob moved
// under `case-*/` and the JS plugin by its absolute path. One run lints every
// case, because starting the linter once per case cost 32 s of the root tests
// in CI. See apinrdw/kumora#171.
import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import type { Vitest } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"

import config from "../vite.config.ts"
import { CommandFailed, collect } from "./lib/command.mts"

const Report = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        help: Schema.optional(Schema.String),
        filename: Schema.String,
      })
    ),
    number_of_files: Schema.Number,
  })
)

interface Fixture {
  readonly file: string
  readonly source: string
}

// Filled while the suites are collected; the Linted layer lints them all
// before the first test runs.
const fixtures: Array<Fixture> = []

const caseDir = (index: number) => `case-${index}`

// The repo's lint block as it applies inside each case directory of a
// temporary root. The bans read syntax alone, and the temporary root installs
// none of the packages a snippet imports, so its type check stays off.
const underCases = (root: string, path: Path.Path) => {
  const { options: _typeChecking, ...lint } = config.lint ?? {}
  const inCases = (glob: string) => `case-*/${glob}`
  const plugins = (jsPlugins: ReadonlyArray<unknown> | null | undefined) =>
    jsPlugins?.map((plugin) =>
      typeof plugin === "string" ? path.join(root, plugin) : plugin
    )
  return {
    ...lint,
    jsPlugins: plugins(lint.jsPlugins),
    ignorePatterns: lint.ignorePatterns?.map(inCases),
    overrides: lint.overrides?.map((override) => ({
      ...override,
      files: override.files.map(inCases),
      jsPlugins: plugins(override.jsPlugins),
    })),
  }
}

// Each case's diagnostics, by fixture index.
class Linted extends Context.Service<
  Linted,
  ReadonlyArray<ReadonlyArray<string>>
>()("lint-bans/Linted") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(import.meta.dirname, "..")
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lint-bans-" })
      const files = fixtures.map(({ file }, index) =>
        path.join(caseDir(index), file)
      )
      // vp lint refuses a directory outside any package.
      yield* fs.writeFileString(
        path.join(dir, "package.json"),
        '{ "name": "lint-bans", "private": true }\n'
      )
      yield* fs.writeFileString(
        path.join(dir, "vite.config.mjs"),
        `export default ${JSON.stringify({ lint: underCases(root, path) })}\n`
      )
      for (const [index, { file, source }] of fixtures.entries()) {
        const at = path.join(dir, caseDir(index), file)
        yield* fs.makeDirectory(path.dirname(at), { recursive: true })
        yield* fs.writeFileString(at, source)
      }
      const vp = path.join(root, "node_modules/.bin/vp")
      const args = ["lint", "--format=json", ...files]
      const result = yield* collect(ChildProcess.make(vp, args, { cwd: dir }))
      const failed = new CommandFailed({
        command: ["vp", ...args].join(" "),
        exitCode: result.exitCode,
        stderr: result.stderr,
      })
      if (result.stdout === "") return yield* failed
      const report = yield* Schema.decodeEffect(Report)(result.stdout)
      if (report.number_of_files !== files.length) return yield* failed
      return files.map((file) =>
        report.diagnostics
          .filter(({ filename }) => filename === file)
          .map(({ code, message, help }) =>
            `${code}: ${message} ${help ?? ""}`.trim()
          )
      )
    })
  ).pipe(Layer.provide(NodeServices.layer))
}

// Registers a fixture at collection time and adds a test that checks the
// diagnostics vp lint gave it.
const lints = (
  it: Vitest.MethodsNonLive<Linted>,
  name: string,
  file: string,
  source: string,
  check: (diagnostics: ReadonlyArray<string>) => void
) => {
  const index = fixtures.push({ file, source }) - 1
  it.effect(name, () =>
    Effect.gen(function* () {
      const diagnostics = (yield* Linted)[index]
      if (diagnostics === undefined)
        return yield* Effect.die(`${name}: registered after the lint run`)
      check(diagnostics)
    })
  )
}

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

const throwAndAsync =
  'export const f = async () => {\n  throw new Error("boom")\n}\n'

const assertThrowAndAsyncBanned = (diagnostics: ReadonlyArray<string>) => {
  assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
  assertBanned(diagnostics, "oxc(no-async-await)", "async")
}

layer(Linted.layer)((suite) => {
  suite.layer(Layer.empty)("Effect lint bans under scripts/", (it) => {
    const script = "scripts/fixture.mts"

    lints(
      it,
      "a clean Effect program lints clean",
      script,
      [
        'import { Effect } from "effect"',
        "",
        "export const wait = (p: Promise<number>): Effect.Effect<number> =>",
        "  Effect.promise(() => p)",
        "",
      ].join("\n"),
      (diagnostics) => assert.deepStrictEqual(diagnostics, [])
    )

    lints(
      it,
      "throw names Effect.fail",
      script,
      'export const f = () => {\n  throw new Error("boom")\n}\n',
      (diagnostics) =>
        assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
    )

    lints(
      it,
      "async is rejected; CODING_STANDARDS.md names Effect.gen",
      script,
      "export const f = async () => 1\nexport async function g() {}\n",
      (diagnostics) => {
        assertBanned(diagnostics, "oxc(no-async-await)", "async")
        assert.strictEqual(
          diagnostics.filter((line) => line.startsWith("oxc(no-async-await)"))
            .length,
          2
        )
      }
    )

    lints(
      it,
      "new Promise and Promise.all name Effect.promise",
      script,
      "export const p = new Promise(() => {})\nexport const q = Promise.all([])\n",
      (diagnostics) =>
        assert.strictEqual(
          diagnostics.filter(
            (line) =>
              line.startsWith("eslint(no-restricted-globals)") &&
              line.includes("Effect.promise")
          ).length,
          2
        )
    )

    lints(
      it,
      "process.exit names the failing Effect",
      script,
      "process.exit(1)\n",
      (diagnostics) =>
        assertBanned(
          diagnostics,
          "eslint(no-restricted-properties)",
          "tagged error"
        )
    )

    lints(
      it,
      "globalThis.process.exit names the failing Effect",
      script,
      "globalThis.process.exit(1)\n",
      (diagnostics) =>
        assertBanned(diagnostics, "kumora(restricted-syntax)", "tagged error")
    )

    lints(
      it,
      "a top-level helper that returns no Effect names Effect.fn",
      script,
      [
        "export function a() {",
        "  return 1",
        "}",
        "const b = (s: string) => s.length",
        "export const c = function () {",
        "  return 2",
        "}",
        "export const d = (s: string) => {",
        "  return s",
        "}",
        "",
        "export { b }",
        "",
      ].join("\n"),
      (diagnostics) => {
        assertBanned(diagnostics, "kumora(effect-functions)", "Effect.fn")
        assert.strictEqual(
          diagnostics.filter((line) =>
            line.startsWith("kumora(effect-functions)")
          ).length,
          4
        )
      }
    )

    lints(
      it,
      "Effect.fn, an Effect chain and a generator's closure pass",
      script,
      [
        'import { Effect } from "effect"',
        "",
        'export const a = Effect.fn("a")(function* (n: number) {',
        "  const double = (m: number) => m * 2",
        "  return double(n)",
        "})",
        "export const b = Effect.fnUntraced(function* () {",
        "  return 1",
        "})",
        "export const c = (n: number) => Effect.succeed(n).pipe(Effect.as(2))",
        "",
      ].join("\n"),
      (diagnostics) => assert.deepStrictEqual(diagnostics, [])
    )

    lints(
      it,
      "a test file may keep plain helpers",
      "scripts/fixture.test.mts",
      "export const double = (n: number) => n * 2\n",
      (diagnostics) => assert.deepStrictEqual(diagnostics, [])
    )

    lints(
      it,
      "process.env names Config",
      script,
      "export const token = process.env.TOKEN\n",
      (diagnostics) =>
        assertBanned(diagnostics, "eslint(no-restricted-properties)", "Config")
    )

    for (const [line, fix] of [
      ['import { readFileSync } from "node:fs"', "FileSystem"],
      ['import { readFile } from "node:fs/promises"', "FileSystem"],
      ['import fs from "fs"', "FileSystem"],
      ['import { spawn } from "node:child_process"', "ChildProcess"],
      ['import { exec } from "child_process"', "ChildProcess"],
    ] as const)
      lints(
        it,
        `${line} names ${fix}`,
        script,
        `${line}\n\nexport { line }\n`,
        (diagnostics) =>
          assertBanned(diagnostics, "eslint(no-restricted-imports)", fix)
      )

    lints(
      it,
      "the root import bans still apply",
      script,
      'import { z } from "zod"\nimport { Schema } from "@effect/schema"\n\nexport { z, Schema }\n',
      (diagnostics) => {
        assertBanned(
          diagnostics,
          "eslint(no-restricted-imports)",
          "Effect Schema"
        )
        assertBanned(diagnostics, "eslint(no-restricted-imports)", "v3")
      }
    )
  })

  suite.layer(Layer.empty)("packages/ui/src is exempt", (it) => {
    lints(
      it,
      "shadcn-style code with throw, async and Promise lints clean",
      "packages/ui/src/components/thing.tsx",
      [
        "export async function load(): Promise<number> {",
        '  if (Math.random() > 2) throw new Error("never")',
        "  return Promise.resolve(process.env.X ? 1 : 0)",
        "}",
        "",
      ].join("\n"),
      (diagnostics) => assert.deepStrictEqual(diagnostics, [])
    )

    lints(
      it,
      "it keeps the root import bans",
      "packages/ui/src/lib/schema.ts",
      'import { z } from "zod"\n\nexport { z }\n',
      (diagnostics) =>
        assertBanned(
          diagnostics,
          "eslint(no-restricted-imports)",
          "Effect Schema"
        )
    )
  })

  suite.layer(Layer.empty)(
    "packages/server is under the full ban set",
    (it) => {
      for (const file of [
        "packages/server/src/thing.ts",
        "packages/server/tests/thing.test.ts",
      ])
        lints(
          it,
          `throw and async in ${file} are rejected`,
          file,
          throwAndAsync,
          assertThrowAndAsyncBanned
        )

      lints(
        it,
        "the bridge may import cloudflare:workers",
        "packages/server/src/bridge.ts",
        'import { env } from "cloudflare:workers"\n\nexport { env }\n',
        (diagnostics) => assert.deepStrictEqual(diagnostics, [])
      )

      lints(
        it,
        "the bridge keeps the other bans",
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
        ].join("\n"),
        (diagnostics) => {
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "FileSystem"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "Effect Schema"
          )
          assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
        }
      )

      lints(
        it,
        "the rest of packages/server may not import cloudflare:workers",
        "packages/server/src/errors.ts",
        'import { env } from "cloudflare:workers"\n\nexport { env }\n',
        (diagnostics) =>
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "WorkerEnv"
          )
      )
    }
  )

  suite.layer(Layer.empty)(
    "packages/deploy is under the full ban set",
    (it) => {
      const envAndExit = [
        "export const swap = () => {",
        "  delete process.env.CLOUDFLARE_API_TOKEN",
        "  process.exit(1)",
        "}",
        "",
      ].join("\n")

      lints(
        it,
        "deploy code may not touch process.env or child_process",
        "packages/deploy/tests/deploy.test.ts",
        [
          'import { spawn } from "node:child_process"',
          "",
          "export { spawn }",
          envAndExit,
        ].join("\n"),
        (diagnostics) => {
          assertBanned(
            diagnostics,
            "eslint(no-restricted-properties)",
            "Config"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "ChildProcess"
          )
        }
      )

      for (const file of [
        "packages/deploy/src/token-swap.ts",
        "packages/deploy/tests/token-swap.test.ts",
      ])
        lints(
          it,
          `${file} may write process.env but not exit`,
          file,
          envAndExit,
          (diagnostics) => {
            assert.isFalse(
              diagnostics.some((line) => line.includes("Config")),
              diagnostics.join("\n")
            )
            assertBanned(
              diagnostics,
              "eslint(no-restricted-properties)",
              "runMain"
            )
          }
        )
    }
  )

  suite.layer(Layer.empty)("apps/web is under the Effect bans", (it) => {
    for (const file of [
      "apps/web/alchemy.run.ts",
      "apps/web/src/router.tsx",
      "apps/web/src/server/thing.ts",
      "apps/web/src/start.ts",
    ])
      lints(
        it,
        `throw and async in ${file} are rejected`,
        file,
        throwAndAsync,
        assertThrowAndAsyncBanned
      )

    lints(
      it,
      "an async loader in a route is rejected",
      "apps/web/src/routes/thing.tsx",
      "export const loader = async () => 1\n",
      (diagnostics) => assertBanned(diagnostics, "oxc(no-async-await)", "async")
    )

    lints(
      it,
      "a route may throw redirect or notFound",
      "apps/web/src/routes/thing.tsx",
      [
        'import { notFound } from "@tanstack/react-router"',
        "",
        "export const beforeLoad = () => {",
        "  throw notFound()",
        "}",
        "",
      ].join("\n"),
      (diagnostics) => assert.deepStrictEqual(diagnostics, [])
    )

    lints(
      it,
      "a route keeps the other bans",
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
      ].join("\n"),
      (diagnostics) => {
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
      }
    )
  })

  suite.layer(Layer.empty)(
    "apps/dashboard's non-component code is under the full ban set",
    (it) => {
      for (const file of [
        "apps/dashboard/alchemy.run.ts",
        "apps/dashboard/src/domain/thing.ts",
        "apps/dashboard/src/lib/thing.ts",
        "apps/dashboard/src/server/auth/thing.ts",
        "apps/dashboard/src/worker.ts",
        "apps/dashboard/src/components/k/thing.ts",
        "apps/dashboard/tests/lib/thing.test.ts",
        "apps/dashboard/tests/server/thing.test.ts",
        "apps/dashboard/tests/components/k/thing.test.ts",
        "apps/dashboard/tests/start.test.ts",
      ])
        lints(
          it,
          `throw and async in ${file} are rejected`,
          file,
          throwAndAsync,
          assertThrowAndAsyncBanned
        )

      lints(
        it,
        "a dashboard lib function keeps the other bans",
        "apps/dashboard/src/lib/thing.ts",
        [
          'import { readFileSync } from "node:fs"',
          "",
          "export { readFileSync }",
          "export const all = Promise.all([])",
          "export const env = process.env.X",
          "",
        ].join("\n"),
        (diagnostics) => {
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "FileSystem"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-globals)",
            "Effect.promise"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-properties)",
            "Config"
          )
        }
      )
    }
  )

  suite.layer(Layer.empty)(
    "apps/dashboard's React code is under the bans, throw allowed in routes",
    (it) => {
      for (const file of [
        "apps/dashboard/src/router.tsx",
        "apps/dashboard/src/components/k/thing.tsx",
        "apps/dashboard/src/components/market-live/thing.tsx",
      ])
        lints(
          it,
          `throw and async in ${file} are rejected`,
          file,
          throwAndAsync,
          assertThrowAndAsyncBanned
        )

      // Spec apinrdw/kumora#113 leaves component tests as they were.
      for (const file of [
        "apps/dashboard/tests/components/k/thing.test.tsx",
        "apps/dashboard/tests/support/thing.tsx",
      ])
        lints(
          it,
          `component tests in ${file} may still use async`,
          file,
          "export const f = async () => {}\n",
          (diagnostics) =>
            assert.isFalse(
              diagnostics.some((line) =>
                line.startsWith("oxc(no-async-await)")
              ),
              diagnostics.join("\n")
            )
        )

      lints(
        it,
        "an async event handler in a component is rejected",
        "apps/dashboard/src/components/account/thing.tsx",
        [
          "export function Thing() {",
          "  const save = async () => {}",
          "  return <button onClick={() => void save()}>Save</button>",
          "}",
          "",
        ].join("\n"),
        (diagnostics) =>
          assertBanned(diagnostics, "oxc(no-async-await)", "async")
      )

      lints(
        it,
        "an async loader in a route is rejected",
        "apps/dashboard/src/routes/_app/thing.tsx",
        "export const loader = async () => 1\n",
        (diagnostics) =>
          assertBanned(diagnostics, "oxc(no-async-await)", "async")
      )

      lints(
        it,
        "a route may throw redirect or notFound",
        "apps/dashboard/src/routes/_app/thing.tsx",
        [
          'import { notFound, redirect } from "@tanstack/react-router"',
          "",
          "export const beforeLoad = (signedIn: boolean) => {",
          '  if (!signedIn) throw redirect({ to: "/sign-in" })',
          "  throw notFound()",
          "}",
          "",
        ].join("\n"),
        (diagnostics) => assert.deepStrictEqual(diagnostics, [])
      )

      lints(
        it,
        "a route keeps the other bans",
        "apps/dashboard/src/routes/thing.tsx",
        [
          'import { readFileSync } from "node:fs"',
          "",
          "export { readFileSync }",
          "export const all = Promise.all([])",
          "export const env = process.env.X",
          "export const exit = () => globalThis.process.exit(1)",
          "",
        ].join("\n"),
        (diagnostics) => {
          assertBanned(
            diagnostics,
            "eslint(no-restricted-imports)",
            "FileSystem"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-globals)",
            "Effect.promise"
          )
          assertBanned(
            diagnostics,
            "eslint(no-restricted-properties)",
            "Config"
          )
          assertBanned(diagnostics, "kumora(restricted-syntax)", "Config")
        }
      )

      lints(
        it,
        "a component may throw nothing, a route's throw included",
        "apps/dashboard/src/components/thing.tsx",
        [
          'import { notFound } from "@tanstack/react-router"',
          "",
          "export const missing = () => {",
          "  throw notFound()",
          "}",
          "",
        ].join("\n"),
        (diagnostics) =>
          assertBanned(diagnostics, "kumora(restricted-syntax)", "Effect.fail")
      )
    }
  )

  suite.layer(Layer.empty)(
    "the tape is the one dashboard module with SQL against the trades table",
    (it) => {
      const tradesSql = [
        'export const one = "SELECT 1 FROM trades WHERE number = ?"',
        "export const many = `INSERT OR IGNORE INTO trades VALUES (?)`",
        "",
      ].join("\n")

      lints(
        it,
        "a string or template naming the trades table names the tape",
        "apps/dashboard/src/server/market-live/thing.ts",
        tradesSql,
        (diagnostics) => {
          assertBanned(diagnostics, "kumora(tape-owns-trades)", "tape.ts")
          assert.strictEqual(diagnostics.length, 2)
        }
      )

      lints(
        it,
        "tape.ts may name it",
        "apps/dashboard/src/server/market-live/tape.ts",
        tradesSql,
        (diagnostics) => assert.deepStrictEqual(diagnostics, [])
      )

      lints(
        it,
        "a dashboard test may name it",
        "apps/dashboard/tests/server/market-live/thing.test.ts",
        tradesSql,
        (diagnostics) => assert.deepStrictEqual(diagnostics, [])
      )

      lints(
        it,
        "other tables and prose lint clean",
        "apps/dashboard/src/server/market-live/thing.ts",
        [
          'export const walks = "SELECT number FROM walk_trades"',
          'export const prose = "the newest trades from trades seen"',
          "",
        ].join("\n"),
        (diagnostics) => assert.deepStrictEqual(diagnostics, [])
      )
    }
  )
})
