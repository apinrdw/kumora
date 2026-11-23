import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Infisical from "@alchemy.run/infisical"
import * as Alchemy from "alchemy"
import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import {
  COMPATIBILITY_DATE,
  parseStage,
  stageTarget,
  type App,
  type DeployTarget,
  type Stage,
  type UnknownStage,
} from "./target.ts"

const INFISICAL_PROJECT = "kumora"

// Alchemy evaluates the stack with PLACEHOLDER_STAGE when it addresses no
// deployment: auth discovery for `alchemy profile edit`, and `alchemy state`.
// Read it as Staging, so discovery sees Cloudflare state and Infisical but the
// stack never reaches for production's secrets. A stack parses Alchemy's stage
// with this once and passes the Stage on.
export const stackStage = Effect.fnUntraced(function* (
  stage: string
): Effect.fn.Return<Stage, UnknownStage> {
  return yield* parseStage(stage === PLACEHOLDER_STAGE ? "staging" : stage)
})

const stackTarget = Effect.fnUntraced(function* (
  app: App,
  stage: string
): Effect.fn.Return<DeployTarget, UnknownStage> {
  return yield* stageTarget(app, yield* stackStage(stage))
})

// Decision: apps deploy as Cloudflare Workers by Workers Builds running alchemy
// (packages/deploy/docs/adr/0002-apps-deploy-as-workers-through-workers-builds-running-alchemy.md)
export const stackOptions = Effect.fnUntraced(function* (app: App) {
  return {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.gen(function* () {
        const stage = yield* Alchemy.Stage
        // The state layer's error type is never, so an unknown Stage dies.
        const { stateStore } = yield* Effect.orDie(stackTarget(app, stage))
        return stateStore === "local"
          ? Alchemy.localState()
          : Cloudflare.state()
      })
    ),
    // Decision: secrets are read from Infisical at deploy and bound as secret_text
    // (packages/deploy/docs/adr/0003-secrets-are-read-from-infisical-at-deploy.md)
    //
    // Alchemy calls this synchronously, so an unknown Stage is a defect that
    // runSync throws.
    secrets: ({ stage }: { readonly stage: string }) => {
      const environment = Effect.runSync(
        Effect.orDie(stackTarget(app, stage))
      ).infisicalEnvironment
      if (environment === undefined) return []
      return ["/", `/${app}`].map((path) =>
        Infisical.Secrets({ project: INFISICAL_PROJECT, environment, path })
      )
    },
  }
})

// Read inside a stack's Effect, where an unknown Stage is a defect alchemy prints.
export const websiteProps = Effect.fnUntraced(function* (
  app: App,
  stage: string
) {
  const { workerName } = yield* Effect.orDie(stackTarget(app, stage))
  return {
    name: workerName,
    compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
    observability: { enabled: true },
  }
})
