// Fake service layers for script tests: no real processes or files.
import { Effect, FileSystem, Layer, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface FakeProcess {
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
}

const bytes = (text: string | undefined) =>
  text === undefined || text === ""
    ? Stream.empty
    : Stream.make(new TextEncoder().encode(text))

// Answers every spawn with `respond(command)` and records the command.
export const recordingSpawner = (
  respond: (command: ChildProcess.StandardCommand) => FakeProcess
) => {
  const calls: Array<ChildProcess.StandardCommand> = []
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command))
          return Effect.die("recordingSpawner: piped commands are not faked")
        calls.push(command)
        const fake = respond(command)
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(fake.exitCode ?? 0)
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: bytes(fake.stdout),
            stderr: bytes(fake.stderr),
            all: Stream.concat(bytes(fake.stdout), bytes(fake.stderr)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        )
      }).pipe(Effect.flatten)
    )
  )
  return { calls, layer }
}

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    module: "FileSystem",
    method,
    _tag: "NotFound",
    description: "No such file or directory",
    pathOrDescriptor: path,
  })

// A read-only file system holding `files`, keyed by absolute POSIX path.
// Directories exist implicitly above each file.
export const memoryFileSystem = (files: Readonly<Record<string, string>>) => {
  const paths = Object.keys(files)
  const isDirectory = (dir: string) =>
    paths.some((file) => file.startsWith(`${dir}/`))
  return FileSystem.layerNoop({
    readFileString: (path) =>
      path in files
        ? Effect.succeed(files[path] as string)
        : Effect.fail(notFound("readFileString", path)),
    exists: (path) => Effect.succeed(path in files || isDirectory(path)),
    readDirectory: (dir, options) => {
      if (!isDirectory(dir)) return Effect.fail(notFound("readDirectory", dir))
      const below = paths
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1))
      const entries = options?.recursive
        ? below
        : below.map((relative) => relative.split("/")[0] as string)
      return Effect.succeed([...new Set(entries)])
    },
  })
}
