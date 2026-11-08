import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stream from "effect/Stream"

// Runs `body` through runMain in a real bun, the way Workers Builds runs an
// entry point.
const runMainWith = Effect.fnUntraced(function* (body: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      "bun",
      [
        "--eval",
        [
          'import * as Console from "effect/Console"',
          'import * as Effect from "effect/Effect"',
          'import { runMain } from "./run.ts"',
          `runMain(${body})`,
        ].join("\n"),
      ],
      { cwd: `${import.meta.dirname}/../src` }
    )
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" }
  )
  return { exitCode, stdout, stderr }
}, Effect.scoped)

layer(NodeServices.layer)("runMain", (it) => {
  // A provider's keep-alive socket outlives a successful deploy; an open
  // server stands in for it here.
  it.effect("a successful program exits 0 despite an open handle", () =>
    Effect.gen(function* () {
      const result = yield* runMainWith(
        "Effect.sync(() => { Bun.serve({ port: 0, fetch: () => new Response() }) })"
      ).pipe(Effect.timeout("3 seconds"))
      assert.deepStrictEqual(result, { exitCode: 0, stdout: "", stderr: "" })
    })
  )

  // The finalizer's line proves the runtime interrupted the program, rather
  // than the signal killing bun.
  it.effect("a SIGINT interrupts the program and exits 130", () =>
    Effect.gen(function* () {
      const result = yield* runMainWith(
        'Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGINT")), Effect.never).pipe(Effect.ensuring(Console.log("interrupted")))'
      )
      assert.deepStrictEqual(result, {
        exitCode: 130,
        stdout: "interrupted\n",
        stderr: "",
      })
    })
  )
})
