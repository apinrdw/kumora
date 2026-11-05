import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Infisical from "@alchemy.run/infisical"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import {
  COMPATIBILITY_DATE,
  parseStage,
  stageTarget,
  type App,
} from "./target.ts"

const INFISICAL_PROJECT = "kumora"

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
        return stageTarget(app, parseStage(stage)).stateStore === "local"
          ? Alchemy.localState()
          : Cloudflare.state()
      })
    ),
    // Decision: secrets are read from Infisical at deploy and bound as
    // secret_text, so a rotation goes live on the next deploy. This supersedes
    // syncing Infisical into Cloudflare; Secrets Store waits until a secret
    // must rotate without a deploy. See apinrdw/kumora#18.
    secrets: ({ stage }: { readonly stage: string }) => {
      const environment = stageTarget(
        app,
        parseStage(stage)
      ).infisicalEnvironment
      if (environment === undefined) return []
      return ["/", `/${app}`].map((path) =>
        Infisical.Secrets({ project: INFISICAL_PROJECT, environment, path })
      )
    },
  }
}

export function websiteProps(app: App, stage: string) {
  return {
    name: stageTarget(app, parseStage(stage)).workerName,
    compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat"] },
    observability: { enabled: true },
  }
}
