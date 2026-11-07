import * as Cloudflare from "@alchemy.run/cloudflare"
import {
  stackOptions,
  stackStageKind,
  stageUrl,
  websiteProps,
} from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

import { SENDER, SENDING_SUBDOMAIN } from "./src/server/auth/sender.ts"

// apps/e2e's playwright.config.ts waits on this port.
const DEV_PORT = 3001

// scripts/auth-schema.ts replays the same directory for the drift check and
// the handler test seam.
const AuthDb = Cloudflare.D1.Database("AuthDb", { migrations: "./migrations" })

// Decision: Production alone owns the mailer.pusat.ai sending subdomain; every
// other stage only binds EMAIL with this sender, so destroying a Preview never
// removes it, and their mail fails until Production has deployed it. Message
// previews are off here, on the subdomain, because Alchemy's SendEmail binding
// has no previewEnabled; the spec asked for it on every binding. See
// apinrdw/kumora#82.
const SendingSubdomain = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
  const zone = yield* Cloudflare.Zone.findZoneByName({
    accountId,
    name: "pusat.ai",
  }).pipe(Effect.orDie)
  if (zone === undefined)
    return yield* Effect.die(new Error("Zone pusat.ai is not in the account"))
  return yield* Cloudflare.Email.SendingSubdomain("MailSender", {
    zoneId: zone.id,
    name: SENDING_SUBDOMAIN,
    previewEnabled: false,
  })
})

export const Website = Cloudflare.Website.Vite(
  "Dashboard",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    return {
      ...websiteProps("dashboard", stage),
      rootDir: import.meta.dirname,
      dev: { port: DEV_PORT, strictPort: true },
      env: {
        AUTH_DB: AuthDb,
        AUTH_BASE_URL: stageUrl("dashboard", stage, DEV_PORT),
        BETTER_AUTH_SECRET: Alchemy.makeRandom("BetterAuthSecret"),
        EMAIL: Cloudflare.Email.SendEmail("Email", {
          allowedSenderAddresses: [SENDER],
        }),
        // Infisical /dashboard on deployed and Dev stages; the process
        // environment on the Test stage (apps/e2e/playwright.config.ts).
        ADMIN_EMAILS: Config.String("ADMIN_EMAILS"),
      },
    }
  })
)

export type DashboardEnv = Cloudflare.InferEnv<typeof Website>

declare module "@workspace/server" {
  interface Register {
    readonly env: DashboardEnv
  }
}

export default Alchemy.Stack(
  "kumora-dashboard",
  stackOptions("dashboard"),
  Effect.gen(function* () {
    const { stage } = yield* Stack
    if (stackStageKind(stage) === "production") yield* SendingSubdomain
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
