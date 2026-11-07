// Deploys and destroys an app's stack in-process through alchemy/Alchemist,
// with the CLI's progress output. packages/deploy never imports the apps:
// importStack loads apps/<app>/alchemy.run.ts by path.
import * as Alchemist from "alchemy/Alchemist"
import * as SigilRenderer from "alchemy/Cli/SigilRenderer"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"

import type { App, Preview, Stage } from "./target.ts"

type Operation = "deploy" | "destroy"

const LABELS: Record<Operation, string> = {
  deploy: "Deploy",
  destroy: "Destroy",
}

// Absolute, because importStack resolves a relative path against the cwd.
const entrypoint = (app: App) =>
  Effect.map(Path.Path, (path) =>
    path.resolve(import.meta.dirname, "../../../apps", app, "alchemy.run.ts")
  )

const operate = (operation: Operation, app: App, stage: Stage) =>
  Effect.gen(function* () {
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
  }).pipe(
    // The plan's build and the stage's state-store lease close with it.
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
