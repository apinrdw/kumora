// The Workers Builds deploy and preview command, one connection per app:
//   deploy <web | dashboard>
import { mintAccessToken } from "@alchemy.run/infisical"
import { Argument, Command } from "effect/cli"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

import { Stacks } from "./stacks.ts"
import { APPS, deployTarget } from "./target.ts"
import { tokenSwap } from "./token-swap.ts"

const env = Config.all({
  branch: Config.NonEmptyString("WORKERS_CI_BRANCH"),
  clientId: Config.NonEmptyString("INFISICAL_CLIENT_ID"),
  clientSecret: Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "INFISICAL_CLIENT_SECRET"
  ),
})

export const deployCommand = Command.make(
  "deploy",
  { app: Argument.Literals("app", APPS) },
  Effect.fnUntraced(function* ({ app }) {
    const { branch, clientId, clientSecret } = yield* env
    const { stage } = yield* deployTarget(app, branch)
    const { token } = yield* mintAccessToken({
      clientId,
      clientSecret: Redacted.value(clientSecret),
    }).pipe(Effect.provide(FetchHttpClient.layer))
    const stacks = yield* Stacks
    yield* Console.log(`Deploying ${app} to stage ${stage}`)
    // Decision: Workers Builds runs two builds of one branch in parallel and
    // the state store has no lock, so overlapping deploys of one stage can
    // race. The risk is accepted; revisit if overlapping deploys cause
    // trouble. See apinrdw/kumora#17.
    yield* Effect.scoped(
      Effect.andThen(tokenSwap(token), stacks.deploy(app, stage))
    )
  })
)
