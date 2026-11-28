// The GitHub teardown job (.github/workflows/teardown-preview.yml):
//   teardown stage <branch>   prints stage=<stage>, and only that, to stdout
//   teardown destroy <stage>  destroys every app's Preview
//   teardown sweep [--dry-run] destroys every Stale Preview (see sweep.ts)
import { Argument, Command } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { destroyEveryApp, failureLine } from "./stacks.ts"
import { sweepCommand } from "./sweep.ts"
import { APPS, Preview, parseStage, Stage, stageForBranch } from "./target.ts"

export class NotAPreview extends Schema.TaggedError<NotAPreview>()(
  "NotAPreview",
  { stage: Stage }
) {
  override get message() {
    return `Refusing to tear down stage "${this.stage}": not a preview.`
  }
}

// Every app's destroy has run before this fails, so one failing app never
// leaves another app's Preview running.
class TeardownFailed extends Schema.TaggedError<TeardownFailed>()(
  "TeardownFailed",
  {
    stage: Preview,
    failures: Schema.Array(
      Schema.Struct({ app: Schema.Literals(APPS), error: Schema.Defect() })
    ),
  }
) {
  override get message() {
    return [
      `Tearing down stage "${this.stage}" failed:`,
      // An Error's message getter is synchronous, and failureLine is pure.
      ...this.failures.map(
        (failure) => `  ${Effect.runSync(failureLine(failure))}`
      ),
    ].join("\n")
  }
}

const preview = Effect.fnUntraced(function* (stage: Stage) {
  return yield* Schema.decodeEffect(Preview)(stage).pipe(
    Effect.mapError(() => new NotAPreview({ stage }))
  )
})

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
    const failures = yield* destroyEveryApp(target)
    if (failures.length > 0)
      return yield* new TeardownFailed({ stage: target, failures })
  })
)

export const teardownCommand = Command.make("teardown").pipe(
  Command.withSubcommands([stage, destroy, sweepCommand])
)
