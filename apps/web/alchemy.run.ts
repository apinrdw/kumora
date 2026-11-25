import * as Cloudflare from "@alchemy.run/cloudflare"
import {
  devPort,
  stackName,
  stageKind,
  stageUrl,
  type Stage,
} from "@workspace/deploy"
import {
  productionZone,
  stackOptions,
  stackStage,
  websiteProps,
} from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

// The waitlist: one row per visitor who left an email on the landing page,
// with their queue number (src/server/waitlist/).
// Decision: the waitlist gets its own D1 in apac, kept on destroy only in Production
// (apps/web/docs/adr/0001-the-waitlist-gets-its-own-d1-kept-only-in-production.md)
const WaitlistDb = Cloudflare.D1.Database("WaitlistDb", {
  migrations: "./waitlist-migrations",
  primaryLocationHint: "apac",
})

export const Website = Cloudflare.Website.Vite(
  "Web",
  Effect.gen(function* () {
    const { stage } = yield* Stack
    const kind = yield* stageKind(yield* Effect.orDie(stackStage(stage)))
    return {
      ...(yield* websiteProps("web", stage)),
      rootDir: import.meta.dirname,
      dev: { port: yield* devPort("web"), strictPort: true },
      env: {
        DEPLOY_PROBE_SECRET: Config.Redacted("DEPLOY_PROBE_SECRET"),
        // Decision: the waitlist gets its own D1 in apac, kept on destroy only in Production
        // (apps/web/docs/adr/0001-the-waitlist-gets-its-own-d1-kept-only-in-production.md)
        WAITLIST_DB: WaitlistDb.pipe(
          RemovalPolicy.retain(kind === "production")
        ),
      },
    }
  })
)

// Production's host, proxied to Cloudflare, where both apps' zone routes
// (websiteProps) pick it up. 100:: is the address-less target for a host
// only Workers answer. The record beats the zone's *.pusat.ai wildcard, so
// the host doesn't hang on it.
const ProductionHost = (stage: Stage) =>
  Effect.gen(function* () {
    return yield* Cloudflare.DNS.Record("ProductionHost", {
      zoneId: (yield* productionZone).id,
      name: new URL(yield* stageUrl("web", stage)).hostname,
      type: "AAAA",
      content: "100::",
      proxied: true,
    })
  })

export type WebEnv = Cloudflare.InferEnv<typeof Website>

declare module "@workspace/server" {
  interface Register {
    readonly env: WebEnv
  }
}

export default Alchemy.Stack(
  // Alchemy.Stack takes its name and options as values; both are pure.
  Effect.runSync(stackName("web")),
  Effect.runSync(stackOptions("web")),
  Effect.gen(function* () {
    const stage = yield* Effect.orDie(stackStage((yield* Stack).stage))
    if ((yield* stageKind(stage)) === "production") yield* ProductionHost(stage)
    const website = yield* Website
    return { url: website.url.as<string>() }
  })
)
