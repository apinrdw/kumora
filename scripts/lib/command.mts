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

export interface Collected {
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

// spawner.lines ignores the exit code, so a failed git would read as an empty,
// passing result. This awaits the code and fails on anything but 0.
export const gitLines = Effect.fn("gitLines")(function* (
  cwd: string,
  args: ReadonlyArray<string>
) {
  const result = yield* collect(ChildProcess.make("git", args, { cwd }))
  if (result.exitCode !== 0)
    return yield* new CommandFailed({
      command: ["git", ...args].join(" "),
      exitCode: result.exitCode,
      stderr: result.stderr,
    })
  return result.stdout.split("\n").filter((line) => line !== "")
})
