import * as Cloudflare from "@alchemy.run/cloudflare"
import {
  devPort,
  TEST,
  isReleaseStage,
  stackName,
  stageKind,
  stageUrl,
  type Stage,
} from "@workspace/deploy"
import { stackOptions, stackStage, websiteProps } from "@workspace/deploy/stack"
import * as Alchemy from "alchemy"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { Stack } from "alchemy/Stack"
import { isResourceState, State } from "alchemy/State"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

import { SENDER, SENDING_SUBDOMAIN } from "./src/server/auth/sender.ts"
import type { RunParams } from "./src/server/archive/run.ts"
import { stageCrons } from "./src/server/stage-crons.ts"

// Every D1 is created in apac. The hint is fixed at creation, so a stage
// whose database predates it had it replaced, copied by a clone that was
// removed once each production cutover was confirmed. A later replace
// copies nothing.
const apacDatabase = (id: string, migrations: string) =>
  Cloudflare.D1.Database(id, { migrations, primaryLocationHint: "apac" })

// The database the stage's last deploy left under this id, read from
// Alchemy's state: the state row is the one place that names it. Undefined
// only on a stage's first deploy. A row mid-replacement has no attributes
// yet; its old generation holds the data. A row without a database id dies,
// so a deploy never replaces a database without copying it.
const previousDatabaseId = Effect.fn("previousDatabaseId")(function* (
  id: string
) {
  const { name, stage } = yield* Stack
  const row = yield* (yield* yield* State)
    .get({ stack: name, stage, fqn: id })
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  const attr = isResourceState(row)
    ? (row.attr ?? ("old" in row ? row.old.attr : undefined))
    : undefined
  const databaseId: unknown = attr?.databaseId
  if (typeof databaseId === "string") return databaseId
  return yield* Effect.die(
    new Error(`${id}'s state row names no database to clone from`)
  )
})

// Which apac AuthDb this is. apac places a new primary anywhere in Asia
// Pacific, and production's first landed in Tokyo, ~90 ms from the
// Singapore requests. Raising the roll renames the database, which makes
// Alchemy create a new one, copy the old one into it (clone runs only on a
// creation), repoint the Worker and delete the old one.
const AUTH_DB_ROLL = 2

// scripts/auth-schema.ts replays the same directory for the drift check and
// the handler test seam. apps/e2e/reset-test-stage.ts reads this resource's
// state file, AuthDb.json, by this id.
// Decision: every D1 is recreated in apac by cloning the one it replaces
// (apps/dashboard/docs/adr/0124-every-d1-is-recreated-in-apac-by-cloning-the-one-it-replaces.md)
const AuthDb = Effect.gen(function* () {
  const { name, stage } = yield* Stack
  const previous = yield* previousDatabaseId("AuthDb")
  return yield* Cloudflare.D1.Database("AuthDb", {
    // D1 names are at most 64 characters.
    name: `${name}-AuthDb-${AUTH_DB_ROLL}-${stage}`.slice(0, 64),
    migrations: "./migrations",
    primaryLocationHint: "apac",
    clone: previous === undefined ? undefined : { databaseId: previous },
  })
})

// Parsed holdings: the parse runs parse reports into it, the stock page
// reads it. Bound on every stage like the archive buckets; only
// Production's fills, since only Production's buckets hold reports.
// Decision: a data set gets a D1 of its own, read replication off
// (apps/dashboard/docs/adr/0001-each-data-set-gets-its-own-d1-with-read-replication-off.md)
//
// Decision: every D1 is recreated in apac by cloning the one it replaces
// (apps/dashboard/docs/adr/0124-every-d1-is-recreated-in-apac-by-cloning-the-one-it-replaces.md)
const HoldingsDb = apacDatabase("HoldingsDb", "./holdings-migrations")

// Each buildable day's broker totals and candles: every stage's trading-day
// objects write their own stage's, and its stock page reads them by range.
// apps/e2e/reset-test-stage.ts reads its state file, BrokerTotalsDb.json, by
// this id, and apps/e2e/support/broker-totals.ts seeds its tables by it, in
// the migration's column order.
// Decision: a data set gets a D1 of its own, read replication off
// (apps/dashboard/docs/adr/0001-each-data-set-gets-its-own-d1-with-read-replication-off.md)
//
// Decision: every D1 is recreated in apac by cloning the one it replaces
// (apps/dashboard/docs/adr/0124-every-d1-is-recreated-in-apac-by-cloning-the-one-it-replaces.md)
const BrokerTotalsDb = apacDatabase(
  "BrokerTotalsDb",
  "./broker-totals-migrations"
)

// Both archives' metadata: the report index, read by the admin pages. On
// every stage like the archive buckets; it fills from its stage's buckets
// (src/server/archive/report-index.ts).
// Decision: a data set gets a D1 of its own, read replication off
// (apps/dashboard/docs/adr/0001-each-data-set-gets-its-own-d1-with-read-replication-off.md)
//
// Decision: every D1 is recreated in apac by cloning the one it replaces
// (apps/dashboard/docs/adr/0124-every-d1-is-recreated-in-apac-by-cloning-the-one-it-replaces.md)
const ArchiveDb = apacDatabase("ArchiveDb", "./archive-migrations")

// Decision: Production alone owns the mailer.pusat.ai sending subdomain
// (apps/dashboard/docs/adr/0002-production-alone-owns-the-mail-sending-subdomain.md)
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
    // Decision: Google sign-in binds by stage, on Production and Staging only
    // (apps/dashboard/docs/adr/0003-google-sign-in-is-bound-by-stage.md)
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
    // Decision: the Test stage alone takes a Market Live clock offset
    // (apps/dashboard/docs/adr/0004-the-test-stage-alone-takes-a-market-live-clock-offset.md)
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
    // Decision: the Test stage alone moves days to R2 in Streaming hours
    // (apps/dashboard/docs/adr/0005-the-test-stage-alone-moves-days-to-r2-in-streaming-hours.md)
    const testMoves: Partial<Record<"MARKET_LIVE_MOVES_ANY_HOUR", "on">> =
      stage === TEST ? { MARKET_LIVE_MOVES_ANY_HOUR: "on" } : {}
    // The stage's crons and their Decisions: src/server/stage-crons.ts.
    const crons = stageCrons((yield* stageKind(stage)) === "production")
    return {
      ...(yield* websiteProps("dashboard", stage)),
      crons,
      rootDir: import.meta.dirname,
      // Market Live's sockets ahead of TanStack Start, and the Durable Object
      // classes (spec apinrdw/kumora#138, "The custom Worker entry and the gate").
      main: "src/worker.ts",
      dev: { port: yield* devPort("dashboard"), strictPort: true },
      env: {
        AUTH_DB: AuthDb,
        HOLDINGS_DB: HoldingsDb,
        BROKER_TOTALS_DB: BrokerTotalsDb,
        // Decision: only Production's ArchiveDb survives a stack destroy
        // (apps/dashboard/docs/adr/0126-only-production-s-archivedb-survives-a-stack-destroy.md)
        ARCHIVE_DB: ArchiveDb.pipe(
          RemovalPolicy.retain((yield* stageKind(stage)) === "production")
        ),
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
        // Cold days: each recorded day's finished answers once it moves out
        // of its trading-day object (src/server/market-live/cold-bucket.ts).
        // Decision: one bucket per stage; only Production's survives a stack destroy
        // (apps/dashboard/docs/adr/0006-only-production-s-buckets-survive-a-stack-destroy.md)
        DAYS_BUCKET: Cloudflare.R2.Bucket("DaysBucket", {
          forceDestroy: (yield* stageKind(stage)) !== "production",
        }),
        // The shareholding archive and its archive run, on every stage, so
        // the code runs the same everywhere; outside Production the bucket
        // stays empty. src/worker.ts exports the Workflow class.
        SHAREHOLDING_ARCHIVE_BUCKET: Cloudflare.R2.Bucket(
          "ShareholdingArchiveBucket",
          // Decision: one bucket per stage; only Production's survives a stack destroy
          // (apps/dashboard/docs/adr/0006-only-production-s-buckets-survive-a-stack-destroy.md)
          { forceDestroy: (yield* stageKind(stage)) !== "production" }
        ),
        // Typed as every archive Workflow is, so the shared start
        // (src/server/archive/runs.ts) can create its runs.
        SHAREHOLDING_ARCHIVE: Cloudflare.Workflow<RunParams>(
          "ShareholdingArchive",
          { className: "ShareholdingArchive" }
        ),
        // The KSEI archive and its KSEI archive run, on every stage like the
        // shareholding archive's, in a bucket of their own.
        KSEI_ARCHIVE_BUCKET: Cloudflare.R2.Bucket(
          "KseiArchiveBucket",
          // Decision: one bucket per stage; only Production's survives a stack destroy
          // (apps/dashboard/docs/adr/0006-only-production-s-buckets-survive-a-stack-destroy.md)
          { forceDestroy: (yield* stageKind(stage)) !== "production" }
        ),
        KSEI_ARCHIVE: Cloudflare.Workflow<RunParams>("KseiArchive", {
          className: "KseiArchive",
        }),
        // The KSEI parse run, which parses the KSEI archive's Kepemilikan
        // Efek files into HoldingsDb, on every stage like the archive runs.
        KSEI_PARSE: Cloudflare.Workflow<RunParams>("KseiParse", {
          className: "KseiParse",
        }),
        // The classification parse run, which parses the shareholding
        // archive's classification reports into HoldingsDb, on every stage
        // like the archive runs.
        CLASSIFICATION_PARSE: Cloudflare.Workflow<RunParams>(
          "ClassificationParse",
          { className: "ClassificationParse" }
        ),
        // The investor-type parse run, which parses the shareholding
        // archive's investor-type reports into HoldingsDb, on every stage
        // like the classification parse run.
        INVESTOR_TYPE_PARSE: Cloudflare.Workflow<RunParams>(
          "InvestorTypeParse",
          { className: "InvestorTypeParse" }
        ),
        // The above-1% parse run, which parses the shareholding archive's
        // holders-above-1% reports into HoldingsDb, on every stage like the
        // other parse runs.
        ABOVE_1_PARSE: Cloudflare.Workflow<RunParams>("Above1Parse", {
          className: "Above1Parse",
        }),
        // The above-5% parse run, which parses the shareholding archive's
        // daily holders-above-5% reports into HoldingsDb, on every stage
        // like the other parse runs.
        ABOVE_5_PARSE: Cloudflare.Workflow<RunParams>("Above5Parse", {
          className: "Above5Parse",
        }),
        // Company logos, which /logos/{CODE} serves (src/server/logos/).
        // On every stage like the archive buckets; only Production's fills.
        LOGO_BUCKET: Cloudflare.R2.Bucket("LogoBucket", {
          forceDestroy: (yield* stageKind(stage)) !== "production",
        }),
        ...google,
        ...clockOffset,
        ...testMoves,
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
