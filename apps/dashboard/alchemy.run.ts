import * as Cloudflare from "@alchemy.run/cloudflare"
import { stackOptions, websiteProps } from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Effect from "effect/Effect"

export const Website = Cloudflare.Website.Vite(
  "Dashboard",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    return {
      ...websiteProps("dashboard", stage),
      rootDir: import.meta.dirname,
      dev: { port: 3001, strictPort: true },
    }
  })
)

export type DashboardEnv = Cloudflare.InferEnv<typeof Website>

export default Alchemy.Stack(
  "kumora-dashboard",
  stackOptions("dashboard"),
  Effect.gen(function* () {
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
