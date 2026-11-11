import * as Cloudflare from "@alchemy.run/cloudflare"
import {
  DEV_PORTS,
  TEST,
  isReleaseStage,
  stackName,
  stageKind,
  stageUrl,
  type Stage,
} from "@workspace/deploy"
import { stackOptions, stackStage, websiteProps } from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

import { SENDER, SENDING_SUBDOMAIN } from "./src/server/auth/sender.ts"

// scripts/auth-schema.ts replays the same directory for the drift check and
// the handler test seam. apps/e2e/reset-test-stage.ts reads this resource's
// state file, AuthDb.json, by this id.
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
// apps/e2e/support/turnstile.ts hands the dummy token this secret accepts.
const TURNSTILE_TEST_KEYS = {
  siteKey: "1x00000000000000000000AA",
  secretKey: Redacted.make("1x0000000000000000000000000000000AA"),
}

// Production and Staging each own a widget for their own hostname.
const turnstileKeys = (stage: Stage) =>
  Effect.gen(function* () {
    if (!(yield* isReleaseStage(stage))) return TURNSTILE_TEST_KEYS
    const widget = yield* Cloudflare.Turnstile.Widget("Turnstile", {
      domains: [new URL(yield* stageUrl("dashboard", stage)).hostname],
      mode: "managed",
    })
    return { siteKey: widget.sitekey, secretKey: widget.secret }
  })

// The Stage this stack runs on. Read inside a stack's Effect, where an unknown
// Stage is a defect alchemy prints.
const currentStage = Effect.gen(function* () {
  return yield* Effect.orDie(stackStage((yield* Stack).stage))
})

export const Website = Cloudflare.Website.Vite(
  "Dashboard",
  Effect.gen(function* () {
    const stage = yield* currentStage
    const turnstile = yield* turnstileKeys(stage)
    // Decision: Google sign-in is enabled by stage, on Production and Staging,
    // never by whether its client secret is present. Previews and Dev stages
    // read Infisical `staging`, which holds the Google client too, and their
    // URLs are not redirect URIs of the OAuth client. The client is bound (from
    // Infisical `/dashboard`) only there, so a missing secret on Production or
    // Staging fails the deploy instead of hiding the button. See
    // apinrdw/kumora#89.
    const google: Partial<
      Record<
        "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET",
        Config.Config<Redacted.Redacted<string>>
      >
    > = (yield* isReleaseStage(stage))
      ? {
          GOOGLE_CLIENT_ID: Config.Redacted("GOOGLE_CLIENT_ID"),
          GOOGLE_CLIENT_SECRET: Config.Redacted("GOOGLE_CLIENT_SECRET"),
        }
      : {}
    // Decision: the Test stage alone takes a Market Live clock offset (ms),
    // so the e2e opens the page in a chosen market phase; no deployed stage
    // can shift it. apps/e2e/support/clock.ts sets it, turbo.json passes it
    // through. See src/server/market-live/market-clock.ts.
    const clockOffset: Partial<
      Record<
        "MARKET_LIVE_CLOCK_OFFSET",
        Config.Config<Redacted.Redacted<string>>
      >
    > =
      stage === TEST
        ? {
            // Unset: no shift.
            MARKET_LIVE_CLOCK_OFFSET: Config.Redacted(
              "MARKET_LIVE_CLOCK_OFFSET"
            ).pipe(Config.withDefault(Redacted.make("0"))),
          }
        : {}
    return {
      ...(yield* websiteProps("dashboard", stage)),
      rootDir: import.meta.dirname,
      // Market Live's sockets ahead of TanStack Start, and the Durable Object
      // classes (spec apinrdw/kumora#138, "The custom Worker entry and the gate").
      main: "src/worker.ts",
      dev: { port: DEV_PORTS.dashboard, strictPort: true },
      env: {
        AUTH_DB: AuthDb,
        AUTH_BASE_URL: yield* stageUrl("dashboard", stage),
        BETTER_AUTH_SECRET: Alchemy.makeRandom("BetterAuthSecret"),
        EMAIL: Cloudflare.Email.SendEmail("Email", {
          allowedSenderAddresses: [SENDER],
        }),
        // Public: the sign-up and reset pages render the widget with it.
        TURNSTILE_SITE_KEY: turnstile.siteKey,
        TURNSTILE_SECRET_KEY: turnstile.secretKey,
        // Infisical /dashboard on deployed and Dev stages; the process
        // environment on the Test stage (apps/e2e/playwright.config.ts sets
        // it, turbo.json passes it through). Redacted, so it binds as
        // secret_text like the other Infisical values (packages/deploy/src/stack.ts).
        ADMIN_EMAILS: Config.Redacted("ADMIN_EMAILS"),
        // The relay's shared secret: Infisical /dashboard of `prod` and
        // `staging` (Previews and Dev stages share staging's); the process
        // environment on the Test stage, like ADMIN_EMAILS.
        INGEST_TOKEN: Config.Redacted("INGEST_TOKEN"),
        // One trading-day object per WIB date; src/worker.ts exports the
        // class. Untyped: the object has no RPC, only fetch, and its module
        // needs Workers types the tests' typecheck runs without.
        // apps/e2e/reset-test-stage.ts empties both classes' local storage
        // by these names before each e2e run.
        TRADING_DAY: Cloudflare.DurableObject("TradingDay"),
        // The one index of sealed days, the day strip's source
        // (src/server/market-live/day-index-object.ts). Untyped, like
        // TRADING_DAY.
        MARKET_LIVE_INDEX: Cloudflare.DurableObject("DayIndex"),
        ...google,
        ...clockOffset,
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
  // Alchemy.Stack takes its name and options as values; both are pure.
  Effect.runSync(stackName("dashboard")),
  Effect.runSync(stackOptions("dashboard")),
  Effect.gen(function* () {
    const stage = yield* currentStage
    if ((yield* stageKind(stage)) === "production") yield* SendingSubdomain
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
