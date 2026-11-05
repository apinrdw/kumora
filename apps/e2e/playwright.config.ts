import { defineConfig } from "@playwright/test"

import { E2E_INGEST_SECRET } from "./tests/relay-secret"

export default defineConfig({
  testDir: "tests",
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { browserName: "chromium" },
  // The live radar test speaks to the relay, so it needs these two. Its secret is exported for it.
  // A .dev.vars, when present, takes precedence over these dummy values.
  // Never reuse a server: a leftover one would hide a startup failure.
  webServer: [
    {
      command:
        "pnpm exec turbo run dev --only --ui=stream --filter=web --filter=dashboard",
      cwd: "../..",
      env: {
        DEPLOY_PROBE_SECRET: "e2e-dummy-not-a-secret",
        RELAY_INGEST_SECRET: E2E_INGEST_SECRET,
        RELAY_TICKET_SECRET: "e2e-dummy-not-a-secret",
      },
      url: "http://localhost:3000/probe",
      stdout: "pipe",
      // The default SIGKILL stops turbo before it can stop the apps.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      // Playwright waits on one URL per entry, and both apps share the command
      // above, so this idle entry only waits for the dashboard's port.
      command: 'node -e "setInterval(() => {}, 1 << 30)"',
      url: "http://localhost:3001/",
    },
  ],
})
