// Deploys and destroys an app's stack in-process through alchemy/Alchemist,
// with the CLI's progress output. packages/deploy never imports the apps:
// importStack loads apps/<app>/alchemy.run.ts by path.
import * as Alchemist from "alchemy/Alchemist"
import * as SigilRenderer from "alchemy/Cli/SigilRenderer"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

import { errorMessage } from "./report.ts"
import { APPS, type App, type Preview, type Stage } from "./target.ts"

type Operation = "deploy" | "destroy"

const LABELS: Record<Operation, string> = {
  deploy: "Deploy",
  destroy: "Destroy",
}

// Absolute, because importStack resolves a relative path against the cwd.
export const entrypoint = Effect.fnUntraced(function* (app: App) {
  const path = yield* Path.Path
  return path.resolve(
    import.meta.dirname,
    "../../../apps",
    app,
    "alchemy.run.ts"
  )
})

const operate = Effect.fnUntraced(
  function* (operation: Operation, app: App, stage: Stage) {
    const plan = yield* entrypoint(app).pipe(
      Effect.flatMap(Alchemist.importStack),
      Effect.flatMap((stack) =>
        // updateStateStore is what the CLI's --yes set.
        Alchemist.plan({ stack, operation, stage, updateStateStore: true })
      ),
      SigilRenderer.planning({ operation: LABELS[operation], stage })
    )
    const output = yield* Alchemist.apply(plan).pipe(
      SigilRenderer.apply(plan, { stage })
    )
    if (output !== undefined) yield* SigilRenderer.outputs(output)
  },
  // The plan's build closes with it. The state store takes no lease; see the
  // Decision in deploy-command.ts.
  Effect.scoped,
  Effect.provide(Layer.mergeAll(Alchemist.layer(), SigilRenderer.layer()))
)

type StackError = Effect.Error<ReturnType<typeof operate>>

export class Stacks extends Context.Service<
  Stacks,
  {
    readonly deploy: (app: App, stage: Stage) => Effect.Effect<void, StackError>
    readonly destroy: (
      app: App,
      stage: Preview
    ) => Effect.Effect<void, StackError>
  }
>()("@workspace/deploy/Stacks") {
  static readonly layer = Layer.succeed(this, {
    deploy: (app, stage) => operate("deploy", app, stage),
    destroy: (app, stage) => operate("destroy", app, stage),
  })
}

// Runs every app's destroy, whatever an earlier one did, and returns the
// apps that failed.
export const destroyEveryApp = Effect.fnUntraced(function* (target: Preview) {
  const stacks = yield* Stacks
  const exits = yield* Effect.forEach(APPS, (app) =>
    Effect.map(Effect.exit(stacks.destroy(app, target)), (exit) => ({
      app,
      exit,
    }))
  )
  return exits.flatMap(({ app, exit }) =>
    Exit.isFailure(exit) ? [{ app, error: Cause.squash(exit.cause) }] : []
  )
})

// One app's failure from destroyEveryApp, as a failure message prints it.
export const failureLine = Effect.fnUntraced(function* ({
  app,
  error,
}: {
  readonly app: App
  readonly error: unknown
}) {
  return `${app}: ${yield* errorMessage(error)}`
})
