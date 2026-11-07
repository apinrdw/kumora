import { defineConfig } from "@playwright/test"
import { TEST, stageUrl } from "@workspace/deploy"

import { ADMIN } from "./support/accounts"

export default defineConfig({
  testDir: "tests",
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { browserName: "chromium" },
  projects: [
    // Signs up and verifies the shared accounts through the UI and saves
    // their signed-in state (support/accounts.ts) for the specs.
    { name: "setup", testMatch: /\.setup\.ts$/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      testIgnore: /too-many-attempts\.spec\.ts$/,
    },
    // Spends a per-IP limit on purpose, so it runs after every other spec.
    {
      name: "limits",
      dependencies: ["chromium"],
      testMatch: /too-many-attempts\.spec\.ts$/,
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
      },
      url: `${stageUrl("web", TEST)}/probe`,
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
      url: `${stageUrl("dashboard", TEST)}/robots.txt`,
      reuseExistingServer: true,
    },
  ],
})
