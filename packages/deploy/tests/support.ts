// Fake services for the entry-point tests: no real alchemy, processes or files.
import { StateStoreError } from "alchemy/State"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"
import * as Terminal from "effect/Terminal"

import { Stacks } from "../src/stacks.ts"
import type { App, Stage } from "../src/target.ts"

// What effect/cli's Command.runWith needs, none of it real.
export const cliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    })
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused"))
  )
)

// Records each deploy and destroy that succeeds. An app in `failing` fails
// every operation with that message instead.
export const fakeStacks = (
  options: { readonly failing?: Partial<Record<App, string>> } = {}
) => {
  const deployed: Array<[App, Stage]> = []
  const destroyed: Array<[App, Stage]> = []
  const record =
    (into: Array<[App, Stage]>) =>
    (app: App, stage: Stage): Effect.Effect<void, StateStoreError> => {
      const message = options.failing?.[app]
      if (message !== undefined)
        return Effect.fail(new StateStoreError({ message }))
      return Effect.sync(() => {
        into.push([app, stage])
      })
    }
  const layer = Layer.succeed(Stacks, {
    deploy: record(deployed),
    destroy: record(destroyed),
  })
  return { deployed, destroyed, layer }
}
