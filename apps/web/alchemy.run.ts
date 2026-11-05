// SCRATCH: throwaway probe for apinrdw/kumora#20. Never merge.
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Infisical from "@alchemy.run/infisical"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

// Local stages never touch Cloudflare state or Infisical.
const stage = process.env.ALCHEMY_STAGE ?? ""
const isLocal = stage === "test" || stage.startsWith("dev_")

const workerName = (s: string) =>
  s === "production" ? "kumora-web" : `kumora-web-${s.replaceAll("_", "-")}`

export const Website = Cloudflare.Website.Vite(
  "Web",
  Stack.useSync(({ stage }) => ({
    name: workerName(stage),
    rootDir: import.meta.dirname,
    compatibility: { date: "2026-10-26", flags: ["nodejs_compat"] },
    observability: { enabled: true },
    dev: { port: 3000 },
    env: { DEPLOY_PROBE_SECRET: Config.Redacted("DEPLOY_PROBE_SECRET") },
  }))
)

export default Alchemy.Stack(
  "kumora-web",
  {
    providers: Cloudflare.providers(),
    state: isLocal ? Alchemy.localState() : Cloudflare.state(),
    secrets: isLocal
      ? []
      : [
          Infisical.Secrets(({ stage }) => ({
            project: "kumora",
            environment: stage === "production" ? "prod" : "staging",
            path: "/",
          })),
          Infisical.Secrets(({ stage }) => ({
            project: "kumora",
            environment: stage === "production" ? "prod" : "staging",
            path: "/web",
          })),
        ],
  },
  Effect.gen(function* () {
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
