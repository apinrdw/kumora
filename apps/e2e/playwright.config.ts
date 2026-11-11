import { defineConfig } from "@playwright/test"
import { TEST } from "@workspace/deploy"

import { ADMIN, testUrl } from "./support/accounts"
import { MARKET_CLOCK_OFFSET } from "./support/clock"
import { TEST_INGEST_TOKEN } from "./support/ingest"

const TRADING_DAY_SPECS = /(market-live[\w-]*|relay-extension)\.spec\.ts$/

export default defineConfig({
  testDir: "tests",
  forbidOnly: Boolean(process.env.CI),
  // Decision: tests, not files, are the unit of parallelism, so one file's
  // tests can run on different workers and shards (apinrdw/kumora#168). A
  // file whose tests form a sequence says so with a serial describe.
  fullyParallel: true,
  reporter: "list",
  use: { browserName: "chromium" },
  projects: [
    // Signs up and verifies the shared accounts through the UI and saves
    // their signed-in state (support/accounts.ts) for the specs.
    { name: "setup", testMatch: /\.setup\.ts$/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: TRADING_DAY_SPECS,
    },
    // Decision: the specs that send trades share one Durable Object, today's
    // trading day, so they run one at a time: a spec running alongside would
    // add trades to the tape it counts. Each test's trades are numbered above
    // everything sent before it (support/ingest.ts freshTradeNumbers), so the
    // order they run in doesn't matter.
    {
      name: "trading-day",
      dependencies: ["setup"],
      testMatch: TRADING_DAY_SPECS,
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
