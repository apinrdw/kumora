import { defineConfig } from "@playwright/test"
import { TEST } from "@workspace/deploy"
import { readdirSync } from "node:fs"

import { ADMIN, testUrl } from "./support/accounts"
import { MARKET_CLOCK_OFFSET } from "./support/clock"
import { TEST_INGEST_TOKEN } from "./support/ingest"
import { onlyFiles, onlyProjects, PROJECTS_SWITCH } from "./support/projects"
import {
  COLD_DAY_SPEC,
  HOLDER_MAP_SPEC,
  HOLDER_MOVES_SPEC,
  pickedFiles,
  RELAY_LOAD_SPEC,
  REPAINT_BENCH_SPEC,
  recording,
  SWITCH,
  TRADING_DAY_SPECS,
  video,
} from "./support/video"

// Refuse a `--` in the arguments. `vp run test:e2e -- <spec>` hands it
// to Playwright, which then drops every filter after it and runs the whole
// suite: 7 agent sessions waited minutes for a one-spec run that way.
if (process.argv.includes("--")) {
  console.error(
    "e2e: drop the `--`. Playwright ignores the spec files and -g after it and runs every test. Run `vp run test:e2e tests/<file>.spec.ts -g <title>`."
  )
  process.exit(2)
}

const testFiles = readdirSync(new URL("tests", import.meta.url))
const recorded = recording(process.env[SWITCH], testFiles)

const projects = [
  // Signs up and verifies the shared accounts through the UI and saves
  // their signed-in state (support/accounts.ts) for the specs.
  { name: "setup", testMatch: /\.setup\.ts$/ },
  {
    name: "chromium",
    dependencies: ["setup"],
    testIgnore: [
      TRADING_DAY_SPECS,
      COLD_DAY_SPEC,
      HOLDER_MOVES_SPEC,
      HOLDER_MAP_SPEC,
      RELAY_LOAD_SPEC,
      REPAINT_BENCH_SPEC,
      ...recorded.chromium,
    ],
  },
  // Video is a worker option, so it can vary per project but not
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
  // Decision: specs that send trades share today's trading day, so run serially
  // (apps/e2e/docs/adr/0001-trading-day-specs-run-one-at-a-time.md)
  {
    name: "trading-day",
    dependencies: ["setup"],
    testMatch: TRADING_DAY_SPECS,
    workers: 1,
    // Not split like chromium, or its two halves would run side
    // by side: when an evidence run picks any trading-day spec, the project
    // records, narrowed to the picked specs.
    ...(recorded.tradingDay ? { use: { video } } : {}),
  },
  // The cold day spec runs after every chromium and trading-day
  // spec. Its walk day's broker totals build writes the one BrokerTotalsDb,
  // whose built days and missing trades the stocks spec counts over every
  // window.
  {
    name: "cold-day",
    dependencies: [
      "setup",
      "chromium",
      "trading-day",
      ...(recorded.chromium.length > 0 ? ["chromium-video"] : []),
    ],
    testMatch: COLD_DAY_SPEC,
    ...(recorded.coldDay ? { use: { video } } : {}),
  },
  // The Holder moves spec runs after every chromium spec too. It parses
  // fixtures into the one HoldingsDb with Parse now, which the shareholding
  // admin spec expects no run of yet, and which the stocks spec's seed
  // empties.
  {
    name: "holder-moves",
    dependencies: [
      "setup",
      "chromium",
      ...(recorded.chromium.length > 0 ? ["chromium-video"] : []),
    ],
    testMatch: HOLDER_MOVES_SPEC,
    ...(recorded.holderMoves ? { use: { video } } : {}),
  },
  // The Holder map spec parses the same fixtures with Parse now, so it runs
  // after the Holder moves spec, whose runs would otherwise overlap its own.
  {
    name: "holder-map",
    dependencies: [
      "setup",
      "chromium",
      ...(recorded.chromium.length > 0 ? ["chromium-video"] : []),
      "holder-moves",
    ],
    testMatch: HOLDER_MAP_SPEC,
    ...(recorded.holderMap ? { use: { video } } : {}),
  },
]

// An evidence run runs only its picked specs, after setup; a CI job runs
// only the projects E2E_PROJECTS names (.github/workflows/e2e.yml). Neither
// waits on a project it leaves out, so each starts from setup's accounts and
// otherwise empty stores.
// Decision: e2e runs on GitHub's free runners; local evidence is video only
// (docs/adr/0024-e2e-runs-on-github-s-free-runners-and-local-evidence-is-video-only.md)
function selected<P extends { readonly name: string }>(all: ReadonlyArray<P>) {
  const picked = pickedFiles(process.env[SWITCH], testFiles)
  const named = process.env[PROJECTS_SWITCH]
  if (picked.length > 0 && named)
    throw new Error(
      `e2e: set ${SWITCH} or ${PROJECTS_SWITCH}, not both: an evidence run picks its own projects.`
    )
  if (picked.length > 0) return onlyFiles(all, picked)
  return named ? onlyProjects(all, named.split(",")) : [...all]
}

const config = defineConfig({
  testDir: "tests",
  // Decision: tests, not files, run in parallel; a sequence uses a serial describe
  // (apps/e2e/docs/adr/0002-tests-not-files-are-the-unit-of-parallelism.md)
  fullyParallel: true,
  // No retries, so a flake the parallelism brings shows up and gets
  // fixed instead of passing on a second try (apinrdw/kumora#168).
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium" },
  projects: selected([
    ...projects,
    // The relay-load spec times the relay against the wall clock,
    // so it runs alone, after every other project: a spec alongside would
    // share the CPU it measures (apinrdw/kumora#233).
    {
      name: "relay-load",
      dependencies: projects.map((project) => project.name),
      testMatch: RELAY_LOAD_SPEC,
      workers: 1,
    },
    // The repaint bench times the charts' paints on the CPU, so it
    // too runs alone, after relay-load, which it would otherwise share the CPU
    // with. It sends trades to today's trading day, which no trading-day
    // spec is reading by then (apinrdw/kumora#272).
    {
      name: "repaint-bench",
      dependencies: [...projects.map((project) => project.name), "relay-load"],
      testMatch: REPAINT_BENCH_SPEC,
      workers: 1,
    },
  ]),
  // Both apps run on alchemy's local `test` stage: local state, no Infisical,
  // so the dummy value below comes from the process environment and no
  // Cloudflare or Infisical credential is needed.
  // Never reuse a server: a leftover one would hide a startup failure.
  webServer: [
    {
      // reset-test-stage.ts first, so the dashboard starts on an empty D1.
      command:
        "node apps/e2e/reset-test-stage.ts && vp exec turbo run dev --only --ui=stream --filter=web --filter=dashboard",
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

// Refuse a run that names only specs of a project waiting on other
// projects. Playwright runs every test of those projects first, so naming
// relay-load's spec ran all 64 tests, and #272's implementer waited minutes
// for its one bench. E2E_PROJECTS with the projects named runs them alone,
// after setup.
const named = process.argv.filter((arg) => arg.endsWith(".spec.ts"))
const waitingFor = (file: string) =>
  (config.projects ?? []).find(
    ({ dependencies = [], testMatch }) =>
      dependencies.some((name) => name !== "setup") &&
      testMatch instanceof RegExp &&
      testMatch.test(file)
  )
if (
  named.length > 0 &&
  named.every(waitingFor) &&
  !process.argv.some(
    (arg) => arg === "--no-deps" || arg.startsWith("--project")
  )
) {
  const only = [...new Set(named.map((file) => waitingFor(file)?.name))]
  console.error(
    `e2e: ${only.join(", ")} first waits for every other project, so this would run the whole suite. Run it alone: \`${PROJECTS_SWITCH}=${only.join(",")} vp run test:e2e\`.`
  )
  process.exit(2)
}

export default config
