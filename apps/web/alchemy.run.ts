import * as Cloudflare from "@alchemy.run/cloudflare"
import { stackOptions, websiteProps } from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export const Website = Cloudflare.Website.Vite(
  "Web",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    return {
      ...(yield* websiteProps("web", stage)),
      rootDir: import.meta.dirname,
      // Strict: falling back would take the dashboard's 3001. apps/e2e's
      // playwright.config.ts waits on both ports.
      dev: { port: 3000, strictPort: true },
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
  "kumora-web",
  stackOptions("web"),
  Effect.gen(function* () {
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
