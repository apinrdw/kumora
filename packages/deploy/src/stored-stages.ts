// The stage names the Alchemy state store holds for an app's stack. They are
// raw names: the store keeps whatever stage alchemy was handed, so a caller
// decodes each one before acting on it.
import * as Alchemist from "alchemy/Alchemist"
import type { StateStoreError } from "alchemy/State"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { entrypoint } from "./stacks.ts"
import { stackName, type App } from "./target.ts"

// Opens the store the app's alchemy.run.ts configures, at alchemy's placeholder
// stage, which stackStage reads as Staging: the shared Cloudflare store.
const list = Effect.fnUntraced(
  function* (app: App) {
    const store = yield* Alchemist.State.store({
      type: "configured",
      entrypoint: yield* entrypoint(app),
    })
    return yield* store.listStages(yield* stackName(app))
  },
  Effect.scoped,
  Effect.provide(Alchemist.layer())
)

type ListError = Effect.Error<ReturnType<typeof list>>

export class StoredStages extends Context.Service<
  StoredStages,
  {
    readonly list: (
      app: App
    ) => Effect.Effect<ReadonlyArray<string>, ListError | StateStoreError>
  }
>()("@workspace/deploy/StoredStages") {
  static readonly layer = Layer.succeed(this, { list })
}
