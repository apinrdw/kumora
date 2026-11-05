import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests",
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: { browserName: "chromium" },
  // A .dev.vars, when present, takes precedence over this dummy value.
  // Never reuse a server: a leftover one would hide a startup failure.
  webServer: [
    {
      command:
        "pnpm exec turbo run dev --only --ui=stream --filter=web --filter=dashboard",
      cwd: "../..",
      env: {
        DEPLOY_PROBE_SECRET: "e2e-dummy-not-a-secret",
      },
      url: "http://localhost:3000/probe",
      stdout: "pipe",
      // The default SIGKILL stops turbo before it can stop the apps.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      // Playwright waits on one URL per entry, and both apps share the command
      // above, so this idle entry only waits for the dashboard's port. The first entry
      // starts the dashboard, which is often up before this entry is checked, so finding
      // it running is success here. It waits on a static file: with no routes yet, `/`
      // answers 404, which Playwright never counts as up.
      command: 'node -e "setInterval(() => {}, 1 << 30)"',
      url: "http://localhost:3001/robots.txt",
      reuseExistingServer: true,
    },
  ],
})
