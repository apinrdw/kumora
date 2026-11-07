import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Path } from "effect"
import { TestConsole } from "effect/testing"

import { CheckFailed } from "./lib/check.mts"
import { memoryFileSystem } from "./lib/testing.mts"
import { checkPackageScripts, unguardedPipes } from "./package-scripts.mts"

const workspace = 'packages:\n  - "apps/*"\n  - "packages/*"\n'
const manifest = (scripts: Record<string, string>) =>
  JSON.stringify({ name: "x", scripts })

const repo = (files: Record<string, string>) =>
  Layer.merge(
    memoryFileSystem({ "/repo/pnpm-workspace.yaml": workspace, ...files }),
    Path.layer
  )

describe("checkPackageScripts", () => {
  it.effect("passes when no script pipes a command that can fail", () =>
    Effect.gen(function* () {
      yield* checkPackageScripts("/repo")
      assert.deepStrictEqual(yield* TestConsole.logLines, [
        "Checked 2 package.json files, no unguarded pipes.",
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/package.json": manifest({ check: "a && b" }),
          "/repo/apps/web/package.json": manifest({ dev: "echo x | cat" }),
          "/repo/apps/notes/README.md": "no manifest here",
        })
      )
    )
  )

  it.effect("fails with CheckFailed naming each unguarded pipe", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(checkPackageScripts("/repo"))
      assert.instanceOf(error, CheckFailed)
      assert.deepStrictEqual(error.findings, [
        'packages/deploy/package.json "secrets": infisical export | wrangler x',
      ])
    }).pipe(
      Effect.provide(
        repo({
          "/repo/package.json": manifest({}),
          "/repo/packages/deploy/package.json": manifest({
            secrets: "infisical export | wrangler x",
          }),
        })
      )
    )
  )
})

it.effect("a pipe whose producer can fail is reported", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes("infisical export | wrangler x"),
      ["infisical export | wrangler x"]
    )
  })
)

it.effect("a captured producer handed to printf is allowed", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(`out=$(a) && printf '%s\\n' "$out" | b`),
      []
    )
  })
)

it.effect("|| is not a pipe", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("a || b"), [])
  })
)

it.effect("every non-final stage must be safe", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("printf x | false | cat"), [
      "printf x | false | cat",
    ])
  })
)

it.effect("a | inside quotes is not a pipe", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(`node -e "console.log('a|b')"`),
      []
    )
    assert.deepStrictEqual(yield* unguardedPipes("grep -E 'x|y' f"), [])
  })
)

it.effect("each && segment is judged on its own", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("a && b | c; d"), ["b | c"])
  })
)

it.effect("a pipe inside a quoted command substitution is reported", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(
        `out="$(infisical export | cat)" && printf '%s\\n' "$out" | b`
      ),
      ["infisical export | cat"]
    )
  })
)

it.effect("an unquoted newline ends a pipeline", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes("printf x\ninfisical export | b"),
      ["infisical export | b"]
    )
  })
)

it.effect("a substitution inside single quotes is literal text", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(`node -e 'console.log("$(a | b)")'`),
      []
    )
  })
)

it.effect("the allowlist matches whole command names", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("printf-json x | b"), [
      "printf-json x | b",
    ])
    assert.deepStrictEqual(yield* unguardedPipes("echo-cli | b"), [
      "echo-cli | b",
    ])
  })
)

it.effect("a background & separates command lists", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes("echo ready & infisical export | b"),
      ["infisical export | b"]
    )
  })
)

it.effect("quotes nested inside a quoted substitution are honoured", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(
        `out="$(printf '%s' "a|b")" && printf '%s\\n' "$out" | cat`
      ),
      []
    )
  })
)

it.effect("a backtick substitution is its own command list", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes("out=`infisical export | cat` && b"),
      ["infisical export | cat"]
    )
  })
)

it.effect("a redirection ampersand is not a separator", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("echo x 2>&1 | cat"), [])
    assert.deepStrictEqual(yield* unguardedPipes("a 2>&1 | cat"), [
      "a 2>&1 | cat",
    ])
  })
)

it.effect("an escaped dollar inside double quotes is literal", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes(`echo "\\$(a | b)"`), [])
  })
)

it.effect("a quoted parenthesis does not end a substitution", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* unguardedPipes(
        `out="$(printf ')' && infisical export | wrangler x)"`
      ),
      ["infisical export | wrangler x"]
    )
  })
)

it.effect("a noclobber redirection is not a pipe", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* unguardedPipes("cat f >| out"), [])
  })
)

it.effect(
  "a backtick substitution inside double quotes keeps its own quotes",
  () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* unguardedPipes(
          'out="`infisical export --env="$ENV" | cat`" && b'
        ),
        ['infisical export --env="$ENV" | cat']
      )
    })
)
