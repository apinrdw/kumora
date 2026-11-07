import * as Cloudflare from "@alchemy.run/cloudflare"
import { DEV_PORTS, stackName } from "@workspace/deploy"
import { stackOptions, stackStage, websiteProps } from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export const Website = Cloudflare.Website.Vite(
  "Web",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    return {
      ...websiteProps("web", stackStage(stage)),
      rootDir: import.meta.dirname,
      dev: { port: DEV_PORTS.web, strictPort: true },
      env: { DEPLOY_PROBE_SECRET: Config.Redacted("DEPLOY_PROBE_SECRET") },
    }
  })
)

export type WebEnv = Cloudflare.InferEnv<typeof Website>

declare module "@workspace/server" {
  interface Register {
    readonly env: WebEnv
  }
}

export default Alchemy.Stack(
  stackName("web"),
  stackOptions("web"),
  Effect.gen(function* () {
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
