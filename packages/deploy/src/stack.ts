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
} from "./target.ts"

const INFISICAL_PROJECT = "kumora"

// Alchemy evaluates the stack with PLACEHOLDER_STAGE when it addresses no
// deployment: auth discovery for `alchemy profile edit`, and `alchemy state`.
// Read it as Staging, so discovery sees Cloudflare state and Infisical but the
// stack never reaches for production's secrets. A stack parses Alchemy's stage
// with this once and passes the Stage on.
export function stackStage(stage: string): Stage {
  return parseStage(stage === PLACEHOLDER_STAGE ? "staging" : stage)
}

function stackTarget(app: App, stage: string): DeployTarget {
  return stageTarget(app, stackStage(stage))
}

// Decision: Cloudflare Workers with static assets, deployed by Workers Builds
// running alchemy. Pages lost because Cloudflare steers new projects to Workers;
// GitHub Actions deploys lost because they need Cloudflare and Infisical
// credentials in CI. See apinrdw/kumora-monorepo#18 and apinrdw/kumora#17.
export function stackOptions(app: App) {
  return {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.gen(function* () {
        const stage = yield* Alchemy.Stage
        return stackTarget(app, stage).stateStore === "local"
          ? Alchemy.localState()
          : Cloudflare.state()
      })
    ),
    // Decision: secrets are read from Infisical at deploy and bound as
    // secret_text, so a rotation goes live on the next deploy. This supersedes
    // syncing Infisical into Cloudflare; Secrets Store waits until a secret
    // must rotate without a deploy. See apinrdw/kumora#18.
    secrets: ({ stage }: { readonly stage: string }) => {
      const environment = stackTarget(app, stage).infisicalEnvironment
      if (environment === undefined) return []
      return ["/", `/${app}`].map((path) =>
        Infisical.Secrets({ project: INFISICAL_PROJECT, environment, path })
      )
    },
  }
}

export function websiteProps(app: App, stage: Stage) {
  return {
    name: stageTarget(app, stage).workerName,
    compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
    observability: { enabled: true },
  }
}
