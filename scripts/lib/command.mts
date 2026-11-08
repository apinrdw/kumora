import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  }
) {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode}${this.stderr === "" ? "." : `:\n${this.stderr.trimEnd()}`}`
  }
}

interface Collected {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// Runs a piped command to completion and returns its exit code and output.
// It never fails on a non-zero exit; the caller decides what that means.
export const collect = Effect.fn("collect")(function* (
  command: ChildProcess.Command
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(command)
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" }
  )
  return { exitCode, stdout, stderr } satisfies Collected
}, Effect.scoped)

// spawner.lines and spawner.string ignore the exit code, so a failed command
// would read as empty, passing output. This awaits the code and fails with
// CommandFailed on anything but 0.
export const stdoutOf = Effect.fn("stdoutOf")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string }
) {
  const result = yield* collect(ChildProcess.make(command, args, options))
  if (result.exitCode !== 0)
    return yield* new CommandFailed({
      command: [command, ...args].join(" "),
      exitCode: result.exitCode,
      stderr: result.stderr,
    })
  return result.stdout
})

export const gitLines = Effect.fn("gitLines")(function* (
  cwd: string,
  args: ReadonlyArray<string>
) {
  const stdout = yield* stdoutOf("git", args, { cwd })
  return stdout.split("\n").filter((line) => line !== "")
})
