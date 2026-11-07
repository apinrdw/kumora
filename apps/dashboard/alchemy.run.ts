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
import * as Redacted from "effect/Redacted"

import { googleSignInOn } from "./src/server/auth/google.ts"
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

// Cloudflare's always-pass Turnstile keys, for every stage without its own
// widget: Previews, Dev and Test never show a real challenge.
const TURNSTILE_TEST_KEYS = {
  siteKey: "1x00000000000000000000AA",
  secretKey: Redacted.make("1x0000000000000000000000000000000AA"),
}

// Production and Staging each own a widget for their own hostname.
const turnstileKeys = (stage: string) =>
  Effect.gen(function* () {
    const kind = stackStageKind(stage)
    if (kind !== "production" && kind !== "staging") return TURNSTILE_TEST_KEYS
    const widget = yield* Cloudflare.Turnstile.Widget("Turnstile", {
      domains: [new URL(stageUrl("dashboard", stage, DEV_PORT)).hostname],
      mode: "managed",
    })
    return { siteKey: widget.sitekey, secretKey: widget.secret }
  })

export const Website = Cloudflare.Website.Vite(
  "Dashboard",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    const turnstile = yield* turnstileKeys(stage)
    // From Infisical `/dashboard`; see googleSignInOn.
    const google: Partial<
      Record<
        "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET",
        Config.Config<Redacted.Redacted<string>>
      >
    > = googleSignInOn(stackStageKind(stage))
      ? {
          GOOGLE_CLIENT_ID: Config.Redacted("GOOGLE_CLIENT_ID"),
          GOOGLE_CLIENT_SECRET: Config.Redacted("GOOGLE_CLIENT_SECRET"),
        }
      : {}
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
        // Public: the sign-up and reset pages render the widget with it.
        TURNSTILE_SITE_KEY: turnstile.siteKey,
        TURNSTILE_SECRET_KEY: turnstile.secretKey,
        // Infisical /dashboard on deployed and Dev stages; the process
        // environment on the Test stage (apps/e2e/playwright.config.ts).
        ADMIN_EMAILS: Config.String("ADMIN_EMAILS"),
        ...google,
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
