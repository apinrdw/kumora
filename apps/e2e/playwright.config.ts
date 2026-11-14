import { defineConfig } from "@playwright/test"
import { TEST } from "@workspace/deploy"
import { readdirSync } from "node:fs"

import { ADMIN, testUrl } from "./support/accounts"
import { MARKET_CLOCK_OFFSET } from "./support/clock"
import { TEST_INGEST_TOKEN } from "./support/ingest"
import {
  RELAY_LOAD_SPEC,
  recording,
  SWITCH,
  TRADING_DAY_SPECS,
  video,
} from "./support/video"

// Decision: refuse a `--` in the arguments. `pnpm test:e2e -- <spec>` hands it
// to Playwright, which then drops every filter after it and runs the whole
// suite: 7 agent sessions waited minutes for a one-spec run that way.
if (process.argv.includes("--")) {
  console.error(
    "e2e: drop the `--`. Playwright ignores the spec files and -g after it and runs every test. Run `pnpm test:e2e tests/<file>.spec.ts -g <title>`."
  )
  process.exit(2)
}

const recorded = recording(
  process.env[SWITCH],
  readdirSync(new URL("tests", import.meta.url))
)

const projects = [
  // Signs up and verifies the shared accounts through the UI and saves
  // their signed-in state (support/accounts.ts) for the specs.
  { name: "setup", testMatch: /\.setup\.ts$/ },
  {
    name: "chromium",
    dependencies: ["setup"],
    testIgnore: [TRADING_DAY_SPECS, RELAY_LOAD_SPEC, ...recorded.chromium],
  },
  // Decision: video is a worker option, so it can vary per project but not
  // per test: the chromium specs an evidence run picks run in a project of
  // their own that records, and the rest record nothing.
  ...(recorded.chromium.length > 0
    ? [
        {
          name: "chromium-video",
          dependencies: ["setup"],
          testMatch: recorded.chromium,
          use: { video },
        },
      ]
    : []),
  // Decision: the specs that send trades share one Durable Object, today's
  // trading day, so they run one at a time: a spec alongside would add
  // trades to the tape it counts. A run has one server and one storage, and
  // the dashboard has no test-only key for a trading day. See
  // apinrdw/kumora#157 and #169.
  {
    name: "trading-day",
    dependencies: ["setup"],
    testMatch: TRADING_DAY_SPECS,
    workers: 1,
    // Decision: not split like chromium, or its two halves would run side
    // by side: when an evidence run picks any trading-day spec, the whole
    // project records.
    ...(recorded.tradingDay ? { use: { video } } : {}),
  },
]

export default defineConfig({
  testDir: "tests",
  // Decision: tests, not files, are the unit of parallelism, so one file's
  // tests can run on different workers (apinrdw/kumora#168). A
  // file whose tests form a sequence says so with a serial describe.
  fullyParallel: true,
  // Decision: no retries, so a flake the parallelism brings shows up and gets
  // fixed instead of passing on a second try (apinrdw/kumora#168).
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium" },
  projects: [
    ...projects,
    // Decision: the relay-load spec times the relay against the wall clock,
    // so it runs alone, after every other project: a spec alongside would
    // share the CPU it measures (apinrdw/kumora#233).
    {
      name: "relay-load",
      dependencies: projects.map((project) => project.name),
      testMatch: RELAY_LOAD_SPEC,
      workers: 1,
    },
  ],
  // Both apps run on alchemy's local `test` stage: local state, no Infisical,
  // so the dummy value below comes from the process environment and no
  // Cloudflare or Infisical credential is needed.
  // Never reuse a server: a leftover one would hide a startup failure.
  webServer: [
    {
      // reset-test-stage.ts first, so the dashboard starts on an empty D1.
      command:
        "node apps/e2e/reset-test-stage.ts && pnpm exec turbo run dev --only --ui=stream --filter=web --filter=dashboard",
      cwd: "../..",
      env: {
        ALCHEMY_STAGE: TEST,
        DEPLOY_PROBE_SECRET: "e2e-dummy-not-a-secret",
        // The Test stage reads ADMIN_EMAILS from here (apinrdw/kumora#86):
        // turbo.json passes it through to apps/dashboard/alchemy.run.ts.
        ADMIN_EMAILS: ADMIN.email,
        // Likewise INGEST_TOKEN; support/ingest.ts's fake relay sends it.
        INGEST_TOKEN: TEST_INGEST_TOKEN,
        // Market Live's clock, shifted into session 1 of a trading day.
        MARKET_LIVE_CLOCK_OFFSET: String(MARKET_CLOCK_OFFSET),
      },
      url: `${testUrl("web")}/probe`,
      stdout: "pipe",
      // The default SIGKILL stops turbo before it can stop the apps.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      // Playwright waits on one URL per entry, and both apps share the command
      // above, so this idle entry only waits for the dashboard's port. The first entry
      // starts the dashboard, which is often up before this entry is checked, so finding
      // it running is success here. It waits on a static file: `/` answers a
      // redirect to sign-in or a 404, neither of which Playwright counts as up.
      command: 'node -e "setInterval(() => {}, 1 << 30)"',
      url: `${testUrl("dashboard")}/robots.txt`,
      reuseExistingServer: true,
    },
  ],
})
