// The GitHub teardown job (.github/workflows/teardown-preview.yml):
//   teardown stage <branch>   prints stage=<stage>, and only that, to stdout
//   teardown destroy <stage>  destroys every app's Preview
import * as Cause from "effect/Cause"
import { Argument, Command } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"

import { Stacks } from "./stacks.ts"
import {
  APPS,
  Preview,
  parseStage,
  stageForBranch,
  type Stage,
} from "./target.ts"

export class NotAPreview extends Schema.TaggedError<NotAPreview>()(
  "NotAPreview",
  { stage: Schema.String }
) {
  override get message() {
    return `Refusing to tear down stage "${this.stage}": not a preview.`
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

// Every app's destroy has run before this fails, so one failing app never
// leaves another app's Preview running.
export class TeardownFailed extends Schema.TaggedError<TeardownFailed>()(
  "TeardownFailed",
  {
    stage: Schema.String,
    failures: Schema.Array(
      Schema.Struct({ app: Schema.Literals(APPS), error: Schema.Defect() })
    ),
  }
) {
  override get message() {
    return [
      `Tearing down stage "${this.stage}" failed:`,
      ...this.failures.map(
        ({ app, error }) => `  ${app}: ${errorMessage(error)}`
      ),
    ].join("\n")
  }
}

const preview = (stage: Stage) =>
  Schema.decodeEffect(Preview)(stage).pipe(
    Effect.mapError(() => new NotAPreview({ stage }))
  )

const stage = Command.make(
  "stage",
  { branch: Argument.String("branch") },
  Effect.fnUntraced(function* ({ branch }) {
    const target = yield* Effect.flatMap(stageForBranch(branch), preview)
    yield* Console.log(`stage=${target}`)
  })
)

const destroy = Command.make(
  "destroy",
  { stage: Argument.String("stage") },
  Effect.fnUntraced(function* (args) {
    const target = yield* Effect.flatMap(parseStage(args.stage), preview)
    const stacks = yield* Stacks
    const exits = yield* Effect.forEach(APPS, (app) =>
      Effect.map(Effect.exit(stacks.destroy(app, target)), (exit) => ({
        app,
        exit,
      }))
    )
    const failures = exits.flatMap(({ app, exit }) =>
      Exit.isFailure(exit) ? [{ app, error: Cause.squash(exit.cause) }] : []
    )
    if (failures.length > 0)
      return yield* new TeardownFailed({ stage: target, failures })
  })
)

export const teardownCommand = Command.make("teardown").pipe(
  Command.withSubcommands([stage, destroy])
)
