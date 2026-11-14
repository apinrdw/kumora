# Effect v4 platform APIs for scripts and deploy

Research for [#100](https://github.com/apinrdw/kumora/issues/100), child of the map [#98](https://github.com/apinrdw/kumora/issues/98). Sources checked on 2026-11-07 against the vendored `repos/effect` at `effect` 4.1.2 (`repos/effect/packages/effect/package.json`), the version `pnpm-workspace.yaml` pins for `effect`, `@effect/platform-node`, `@effect/platform-bun` and `@effect/vitest`.

Paths below are relative to `repos/effect/` unless they start with `packages/deploy` or `scripts/`. "Unstable" means the source carries `@stability unstable`: it can break in a minor release.

## Answer

- **Entry point:** `NodeRuntime.runMain` (scripts) and `BunRuntime.runMain` (deploy) replace top-level `await` plus `process.exit`. Success exits 0, interruption exits 130, and any other failure exits with the error's `[Runtime.errorExitCode]`, or 1. A typed error can carry the child's exit code that way. Unstable.
- **Services:** `FileSystem`, `Path` and `ChildProcessSpawner` from `effect`, provided by `NodeServices.layer` or `BunServices.layer`. The Bun layers are re-exports of the same Node-shared code, so the two platforms behave the same for everything scripts and deploy use. All unstable.
- **Child processes:** `ChildProcess.make("bun", [...], { cwd, env, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" })` with `spawner.exitCode(...)` replaces `spawn(..., { stdio: "inherit" })`. Every stream defaults to `"pipe"`, so each one must be set to `"inherit"` explicitly. `spawner.lines` and `spawner.string` do **not** check the exit code.
- **Env and argv:** `Config.String`/`Config.Redacted`/`Config.Literals` read env through the default `ConfigProvider.fromEnv()` (stable). Argv comes from the `Stdio` service (`process.argv.slice(2)`), and `effect/cli` `Command.run` parses it with typed `Argument`s, `Flag`s and subcommands (unstable).
- **Tests:** `@effect/vitest` `it.effect` runs each test with `TestConsole` and `TestClock`. Fake services are plain layers: `ChildProcessSpawner.make` plus `makeHandle` for a recording spawner, `FileSystem.layerNoop` for a stubbed file system, `Path.layer` (built-in POSIX), `Stdio.layerTest({ args })` for argv, and `ConfigProvider.fromUnknown`/`fromEnv({ env })` for env.

## 1. Running a program: `runMain` and exit codes

| Fact | Source |
| --- | --- |
| `NodeRuntime.runMain(effect, { disableErrorReporting?, teardown? })`. `BunRuntime.runMain` has the same signature and is the same function: both re-export `@effect/platform-node-shared/NodeRuntime`. Unstable. | `packages/platform/node/src/NodeRuntime.ts`, `packages/platform/bun/src/BunRuntime.ts` |
| The shared runner forks the main fiber, interrupts it on `SIGINT`/`SIGTERM`, and on exit calls `teardown(exit, code => if (receivedSignal \|\| code !== 0) process.exit(code))`. On success it does not call `process.exit`; the process ends when the event loop drains. | `packages/platform/node-shared/src/NodeRuntime.ts` |
| `Runtime.defaultTeardown`: `0` on success, `130` when the cause has only interruptions, else `getErrorExitCode(Cause.squash(cause))`, which reads a numeric `[Runtime.errorExitCode]` property and falls back to `1`. Stable. | `packages/effect/src/Runtime.ts` lines 66–118, 319–328 |
| Unless `disableErrorReporting: true`, `runMain` logs the failure cause with `Effect.logError`, except when the error has `[Runtime.errorReported] = false`. | `packages/effect/src/Runtime.ts` `makeRunMain` (lines ~185–230), `getErrorReported` (line 410) |
| The CLI uses the same markers: `CliError.ShowHelp` sets `[Runtime.errorExitCode]` to `1` when there are parse errors and `0` for plain `--help`, and `[Runtime.errorReported] = false` because the CLI already printed it. | `packages/effect/src/cli/CliError.ts` lines 780–795 |
| The default logger writes with `console.log` (stdout) unless the `References.LogToStderr` reference is `true`. | `packages/effect/src/internal/effect.ts` `defaultLogger` (line ~6957); `packages/effect/src/References.ts` line 656 |

What this means for kumora:

- `process.exit(await runAlchemy(...))` in `deploy.ts` and `if (code !== 0) process.exit(code)` in `teardown.ts` become a typed failure whose class sets `[Runtime.errorExitCode]` to alchemy's code. `runMain` then exits with that code. This is the same pattern `ShowHelp` uses.
- **Gotcha: error logs go to stdout.** `teardown.ts stage` writes `stage=...` to stdout, and the workflow appends stdout to `$GITHUB_OUTPUT`. Today a thrown `Error` prints to stderr. Under `runMain`, the failure log goes to stdout unless the logger is redirected. `runMain` logs outside the program, so providing `LogToStderr` inside the program does not cover that log. Two options: pass `disableErrorReporting: true` and log the cause with `Effect.tapCause(Effect.logError)` inside a scope that provides `References.LogToStderr` set to `true`, or install a stderr logger (`Logger.withConsoleError`) the same way.

## 2. FileSystem and Path

| Fact | Source |
| --- | --- |
| `FileSystem` is a service from `effect/FileSystem`, with `readFileString`, `writeFileString`, `readDirectory`, `exists`, `stat`, `glob`, `makeTempDirectoryScoped`, `remove`, `watch` and more. All methods fail with `PlatformError`. Unstable (whole module). | `packages/effect/src/FileSystem.ts` lines 11, 81–430 |
| `exists` maps a `NotFound` `PlatformError` to `false`. | `packages/effect/src/FileSystem.ts` `make`, lines 567–582 |
| `FileSystem.glob` relies on `effect/Glob`, which is `@stability experimental`. | `packages/effect/src/Glob.ts` line 5 |
| `FileSystem.layerNoop(partial)` and `makeNoop(partial)` build a test file system: methods you pass are used, every other method fails with `NotFound`. | `packages/effect/src/FileSystem.ts` lines 712, 848 |
| `Path` service: `join`, `resolve`, `dirname`, `relative`, `basename`, `fromFileUrl`, `toFileUrl`, `resolveWithin`. Unstable. `Path.layer` in `effect` itself is a built-in POSIX implementation that needs no platform package. | `packages/effect/src/Path.ts` lines 10, 99–113, 931 |
| `NodeFileSystem.layer`/`NodePath.layer` and `BunFileSystem.layer`/`BunPath.layer` are all the `@effect/platform-node-shared` implementations. | `packages/platform/bun/src/BunFileSystem.ts`, `packages/platform/bun/src/BunPath.ts`, `packages/platform/node/src/NodeFileSystem.ts`, `packages/platform/node/src/NodePath.ts` |

`readFileSync`, `readdirSync`, `existsSync` and `statSync` in `scripts/check-package-scripts.mts`, `check-skill-links.mts`, `check-decision-docs.mts` and the tests map one-to-one onto `fs.readFileString`, `fs.readDirectory`, `fs.exists` and `fs.stat`. `resolve`/`join`/`dirname` from `node:path` map onto `path.resolve`/`path.join`/`path.dirname` from the `Path` service. `import.meta.dirname` is a value, not an API, and can stay.

## 3. Child processes

| Fact | Source |
| --- | --- |
| `ChildProcess.make(command, args, options)` builds a command value. A template-literal form (`` make`git status` ``) also exists. `pipeTo` composes pipelines. Unstable. | `packages/effect/src/process/ChildProcess.ts` lines 690–740, 825 |
| A `Command` is itself yieldable: `yield* cmd` spawns it through the current `ChildProcessSpawner` (needs a `Scope`). | `packages/effect/src/process/ChildProcess.ts` `Proto.evaluate`, lines 618–627 |
| Options: `cwd`, `env`, `extendEnv`, `shell`, `detached`, `stdin`, `stdout`, `stderr` (each `"pipe" \| "inherit" \| "ignore" \| "overlapped"` or a Stream/Sink), `killSignal`, `forceKillAfter`, `additionalFds`. There is no single `stdio` option. | `packages/effect/src/process/ChildProcess.ts` lines 162–180, 443–557 |
| `env` alone **replaces** the child environment (no `PATH`). With `extendEnv: true` it merges over `process.env`; a key set to `undefined` is removed; `Redacted` values are unwrapped for the child and never shown in errors. | `ChildProcess.ts` lines 449–478; `packages/platform/node-shared/src/NodeChildProcessSpawner.ts` `resolveEnvironment`, lines 181–189 |
| Each stream defaults to `"pipe"` when unset. | `NodeChildProcessSpawner.ts` `resolveStdinOption`/`resolveOutputOption`, lines 197–229 |
| `detached` defaults to `true` on non-Windows, so the child leads its own process group. On scope close or interruption the spawner signals the whole group (`process.kill(-pid, killSignal ?? "SIGTERM")`) and waits for it. | `ChildProcess.ts` (`detached` doc); `NodeChildProcessSpawner.ts` lines 1–30, 505–540, 680–705 |
| The spawner service: `spawn` (scoped handle), `exitCode(cmd)`, `string`, `lines`, `streamString`, `streamLines`. `exitCode` drains piped output and returns once the process exits. `string`/`lines` collect stdout only and **do not check the exit code**. | `packages/effect/src/process/ChildProcessSpawner.ts` lines 237–330 |
| `ExitCode` is a branded number. A child killed by a signal (code `null`) makes `handle.exitCode` **fail** with a `PlatformError`, where the current `runAlchemy` returns `1`. | `ChildProcessSpawner.ts` lines 31–40; `NodeChildProcessSpawner.ts` lines 732–747 |
| `NodeChildProcessSpawner.layer` needs `FileSystem` and `Path`: it checks `cwd` with `fs.access` and resolves it with `path.resolve`. | `NodeChildProcessSpawner.ts` lines 172–179, 861–865 |
| `NodeServices.layer` = spawner + FileSystem + Path + Stdio + Terminal. `BunServices.layer` is the same set. `BunChildProcessSpawner` re-exports the Node-shared spawner (`node:child_process`, which Bun implements). | `packages/platform/node/src/NodeServices.ts`, `packages/platform/bun/src/BunServices.ts`, `packages/platform/bun/src/BunChildProcessSpawner.ts` |
| LLMS.md's child-process guide shows `spawner.string`, `spawner.lines`, `pipeTo`, and `spawn` + `handle.exitCode` checked against `ExitCode(0)`, scoped with `Effect.scoped`. | `LLMS.md` § Working with child processes; `ai-docs/src/60_child-process/10_working-with-child-processes.ts` |

Gotchas for kumora:

- **`check-no-gitlinks` and `check-decision-docs` must not use bare `spawner.lines`.** `execFileSync` throws when git exits non-zero; `lines` would return an empty list, and the check would pass. Spawn, collect stdout and await `handle.exitCode` together, then fail on a non-zero code (sketch below). Set `stderr: "inherit"` so git's message reaches the user and an unread pipe cannot fill up.
- The `maxBuffer: 256 MiB` workaround goes away: output is streamed, not buffered by Node.
- Detached children: Ctrl+C in a terminal reaches the `bun` parent only. `runMain` interrupts the fiber, the scope closes, and the spawner sends `SIGTERM` to alchemy's group. Pass `killSignal: "SIGINT"` if alchemy should see the same signal a terminal would send. CI is unaffected.

## 4. Env and argv: Config, Stdio and `effect/cli`

| Fact | Source |
| --- | --- |
| `Config` values are yieldable in `Effect.gen` and read from the `ConfigProvider` reference, whose default is `ConfigProvider.fromEnv()` (merges `process.env` and `import.meta.env`). Stable. | `packages/effect/src/Config.ts` line 103; `packages/effect/src/ConfigProvider.ts` lines 351–354, 945–960 |
| `fromEnv` treats an empty string as missing by default, which matches the current `requireEnv` (`if (!value)`). | `ConfigProvider.ts` `fromEnvRecord`/`fromEnv` docs, lines 870–945 |
| Constructors: `Config.String`, `Config.NonEmptyString`, `Config.Redacted`, `Config.Literals(literals, name)`, `Config.schema(codec, name)`, plus `Config.withDefault` and `Config.option`. | `Config.ts` lines 486, 532, 854, 981, 1003, 1131, 1490 |
| Tests swap the provider: `ConfigProvider.fromUnknown({...})`, `ConfigProvider.fromEnv({ env: {...} })`, installed with `ConfigProvider.layer(...)` or `Effect.provideService(ConfigProvider.ConfigProvider, ...)`. | `ConfigProvider.ts` lines 330–345, 682, 797 |
| Argv is not a Config source. The `Stdio` service exposes `args`; `NodeStdio.layer` (also used by Bun) reads `process.argv.slice(2)`. `Stdio.layerTest({ args: Effect.succeed([...]) })` fakes it. Unstable. | `packages/effect/src/Stdio.ts` lines 69, 165–176; `packages/platform/node-shared/src/NodeStdio.ts` line 32 |
| `effect/cli`: `Command.make(name, { ...Argument/Flag }, handler)`, `Command.withSubcommands`, `Command.run({ version })` (args from `Stdio`), `Command.runWith(command, config)(args)` (explicit args, for tests). The handler environment is `FileSystem \| Path \| Terminal \| ChildProcessSpawner \| Stdio`, all supplied by `NodeServices.layer`/`BunServices.layer`. Unstable. | `packages/effect/src/cli/Command.ts` lines 1–13, 407, 1869–1960; `ai-docs/src/70_cli/10_basics.ts` |
| `Argument.String`, `Argument.Literals`, `Argument.withSchema`, `Argument.withFallbackConfig(Config...)`, `Flag.String`, `Flag.Boolean`, `Flag.Literals`, `Flag.optional`, `Flag.withDefault`. | `packages/effect/src/cli/Argument.ts` lines 62–730; `ai-docs/src/70_cli/10_basics.ts` |
| `Command.run` renders parse errors and help itself and marks them reported; a handler failure annotated with `CliError.userMessage` is rendered with the CLI formatter before it is rethrown. | `Command.ts` lines 1858–1880; `CliError.ts` line 690 |

For `packages/deploy`: `deploy.ts <app>` is one positional, so `Argument.Literals("app", APPS)` replaces `parseApp`. `teardown.ts stage <branch>` / `destroy <stage>` become two subcommands, which replaces the hand-written `if/else` and its error. `WORKERS_CI_BRANCH` becomes `Config.NonEmptyString`, and the Infisical client ID and secret become `Config.Redacted`. The token is passed to `ChildProcess` as a `Redacted` value (no `Redacted.value`), and `CLOUDFLARE_API_TOKEN: undefined` with `extendEnv: true` replaces `delete env.CLOUDFLARE_API_TOKEN`.

For `scripts/*.mts`: they take no arguments. They need `runMain`, `FileSystem`, `Path` and `ChildProcessSpawner`, not `effect/cli`.

## 5. Node vs Bun

| Service | `@effect/platform-node` | `@effect/platform-bun` |
| --- | --- | --- |
| `runMain` | node-shared `NodeRuntime` | same function |
| `FileSystem`, `Path`, `Stdio`, `Terminal` | node-shared | same layers |
| `ChildProcessSpawner` | node-shared (`node:child_process`) | same, running on Bun's `node:child_process` |
| HTTP server, sockets, workers, Redis | Node-specific modules | Bun-specific modules (`BunHttpServer`, `BunWorker`, …) |

Sources: `packages/platform/bun/src/*.ts` (each of `BunRuntime`, `BunFileSystem`, `BunPath`, `BunStdio`, `BunTerminal`, `BunChildProcessSpawner` imports from `@effect/platform-node-shared`), `packages/platform/bun/package.json` (depends on `@effect/platform-node-shared`).

Differences that matter here are small. The `additionalFds` doc notes that half-close and `net.Socket` on extra descriptors do not work on Bun (`ChildProcess.ts` lines 565–580), which kumora does not use. Recommendation: `packages/deploy` imports `BunRuntime`/`BunServices`, since it runs under `bun`, and scripts import `NodeRuntime`/`NodeServices`. Because the code is shared, tests run under vitest on Node still exercise the same implementation.

Dependency changes this implies: `packages/deploy/package.json` adds `@effect/platform-bun` and `@effect/vitest` (it has `effect` and `vitest ^5.0.5` already). The root `package.json` adds `effect` and `@effect/vitest` (it has both platform packages and `vitest ^5.0.5`). `@effect/vitest` 4.1.2 peers on `vitest >=5.0.0 <6.0.0` (`packages/vitest/package.json`). Root scripts run with `node` type stripping (`engines.node >=22.18.0`), and Effect code in `.mts` needs nothing Node can't strip.

## 6. Testing with `@effect/vitest`

| Fact | Source |
| --- | --- |
| `it.effect(name, () => effect)` runs an Effect test with a `Scope` and the test services `TestConsole` and `TestClock`. `it.live` runs without them. `layer(L)("suite", it => ...)` shares one layer across a block and tears it down in `afterAll`. `excludeTestServices` and `buildPerTest` are options. The package re-exports all of `vitest`. Unstable. | `packages/vitest/src/index.ts` lines 1–40, 255–268, 359–372; `packages/vitest/src/internal/internal.ts` lines 66–68 |
| `TestConsole.logLines` / `errorLines` return what the program wrote through `Console`. | `packages/effect/src/testing/TestConsole.ts` lines 71–81, 337, 376 |
| A fake spawner is `ChildProcessSpawner.make(spawn)` where `spawn` returns `ChildProcessSpawner.makeHandle({ pid, exitCode, stdout, stderr, all, stdin, isRunning, kill, getInputFd, getOutputFd, unref })`. `make` derives `exitCode`, `lines` and `string` from your `spawn`. Effect's own tests do this. | `ChildProcessSpawner.ts` lines 226, 237; `packages/effect/test/process/ChildProcess.test.ts` lines 12–46 |
| The CLI docs build a full test environment from `FileSystem.layerNoop({})`, `Path.layer`, `Stdio.layerTest({ args })`, a stub `Terminal.make(...)` and a dying `ChildProcessSpawner.make(() => Effect.die("unused"))`. | `Command.ts` doc examples, lines 60–80, 1886–1925 |
| LLMS.md's testing guide: service layers with `Layer.provideMerge` so tests can reach the test ref directly. | `ai-docs/src/09_testing/20_layer-tests.ts` |

So a test provides a recording `ChildProcessSpawner` and `Path.layer` in place of `BunServices.layer`, asserts the recorded `command`, `args` and `options.cwd`, and fakes the exit code. For file-system checks, `FileSystem.layerNoop({ readFileString, readDirectory, exists })` stubs the methods a test needs. Alternatively, the real `NodeFileSystem.layer` with `fs.makeTempDirectoryScoped()` gives a real temporary tree, which the `Scope` from `it.effect` cleans up. To test a failure exit code, use `Effect.flip` to get the typed error and assert its code, rather than running `runMain`.

## 7. Sketches (v4 style, not compiled)

### `runAlchemy` in `packages/deploy/src/alchemy-cli.ts`

```ts
import { Effect, Path, Runtime, Schema } from "effect"
import type * as Redacted from "effect/Redacted"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { App } from "./target.ts"

export class AlchemyFailed extends Schema.TaggedError<AlchemyFailed>()(
  "AlchemyFailed",
  { app: Schema.String, code: Schema.Number }
) {
  // runMain exits with alchemy's own code, as process.exit(code) did.
  override readonly [Runtime.errorExitCode] = this.code
}

type ChildEnv = Record<string, string | Redacted.Redacted<string> | undefined>

// Runs the app's own alchemy CLI in its folder, where its alchemy.run.ts lives.
export const runAlchemy = Effect.fn("runAlchemy")(function* (
  app: App,
  args: ReadonlyArray<string>,
  env: ChildEnv = {}
) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const code = yield* spawner.exitCode(
    ChildProcess.make("bun", ["alchemy", ...args, "--yes"], {
      cwd: path.resolve(import.meta.dirname, "../../../apps", app),
      env,
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
  )
  if (code !== 0) return yield* new AlchemyFailed({ app, code })
})
```

`teardown.ts destroy` becomes `Effect.forEach(APPS, (app) => runAlchemy(app, ["destroy", "--stage", stage]), { discard: true })`, which stops at the first failure as the loop does now. `deploy.ts` passes `{ INFISICAL_TOKEN: token, CLOUDFLARE_API_TOKEN: undefined }`. Each entry file ends with `program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)`.

A test with a recording spawner:

```ts
import { assert, it } from "@effect/vitest"
import { Effect, Layer, Path, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const recording = (code: number) => {
  const calls: Array<ChildProcess.StandardCommand> = []
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) calls.push(command)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
      })
    )
  )
  return { calls, layer: Layer.merge(layer, Path.layer) }
}

it.effect("fails with alchemy's exit code", () => {
  const { calls, layer } = recording(3)
  return Effect.gen(function* () {
    const error = yield* Effect.flip(runAlchemy("web", ["destroy", "--stage", "pr-1"]))
    assert.strictEqual(error.code, 3)
    assert.deepStrictEqual(calls[0]?.args, ["alchemy", "destroy", "--stage", "pr-1", "--yes"])
    assert.isTrue(calls[0]?.options.cwd?.endsWith("/apps/web"))
  }).pipe(Effect.provide(layer))
})
```

### `scripts/check-no-gitlinks.mts`

Follow the existing `package-scripts.mts` / `check-package-scripts.mts` split: the program lives in an importable module so tests need not run the entry file. `import.meta.main` is not available on every Node that `engines` allows.

```ts
// scripts/gitlinks.mts
import { Console, Effect, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  code: Schema.Number,
}) {}

export class GitlinksFound extends Schema.TaggedError<GitlinksFound>()(
  "GitlinksFound",
  { paths: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Submodule entries break the Workers Builds clone. Remove them with \`git rm --cached <path>\` (repos/ is reference only):\n${this.paths.join("\n")}`
  }
}

// spawner.lines ignores the exit code, so collect stdout and await the code
// together: a failed git must not read as an empty, passing index.
const gitLines = Effect.fn("gitLines")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("git", args, { cwd, stderr: "inherit" })
  )
  const [lines, code] = yield* Effect.all(
    [Stream.runCollect(Stream.splitLines(Stream.decodeText(handle.stdout))), handle.exitCode],
    { concurrency: 2 }
  )
  if (code !== 0) return yield* new GitFailed({ code })
  return lines
}, Effect.scoped)

export const checkNoGitlinks = Effect.gen(function* () {
  const path = yield* Path.Path
  const lines = yield* gitLines(path.resolve(import.meta.dirname, ".."), ["ls-files", "--stage"])
  const gitlinks = lines
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.split("\t")[1] ?? "")
  if (gitlinks.length > 0) return yield* new GitlinksFound({ paths: gitlinks })
  yield* Console.log("No submodule entries in the index.")
})
```

```ts
// scripts/check-no-gitlinks.mts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"

import { checkNoGitlinks } from "./gitlinks.mts"

checkNoGitlinks.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
```

`GitlinksFound` exits with code 1, the default. With default error reporting, `runMain` prints its message through the logger, on stdout (section 1). Under `pnpm check` only the exit code matters.

## Open questions

- **Log stream:** route `runMain` failure logs to stderr everywhere (a shared `runScript` helper that sets `LogToStderr` and `disableErrorReporting`), or only in `teardown.ts stage`, where stdout is machine-read.
- **`effect/cli` or Config only:** use `effect/cli` for the two deploy entry points (subcommands, help, typed positionals), or keep argv parsing minimal. The CLI module is unstable, and kumora's two commands are small.
- **Git helper location:** where the checked-exit `gitLines` helper lives, since `check-no-gitlinks`, `check-decision-docs` and two tests all shell out to git or pnpm.
- **Signal-killed child:** a signal-killed alchemy becomes a `PlatformError` (exit 1 through `runMain`), as today. Should it be mapped to `AlchemyFailed` with `128 + signal`?
- **Unstable surface:** every API here except `Config`, `ConfigProvider`, `Console` and `Runtime` is `@stability unstable` (and `Glob` is experimental). The exact `4.1.2` pin in `pnpm-workspace.yaml` already covers this risk. A version bump should re-run the deploy tests.
