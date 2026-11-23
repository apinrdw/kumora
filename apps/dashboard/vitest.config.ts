import { configDefaults, defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// The row budgets (tests/server/market-live/row-budgets.workerd.test.ts) run
// the day object in workerd; `pnpm --filter dashboard test:row-budgets` runs
// them alone.
const ROW_BUDGETS = "tests/**/*.workerd.test.ts"
// Decision: the whole busy day runs on request, outside pnpm check and CI
// (apps/dashboard/docs/adr/0011-the-whole-busy-day-runs-outside-pnpm-check-and-ci.md)
const WHOLE_DAY = "tests/**/whole-day.workerd.test.ts"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
// Vite transforms JSX on its own, so the suites need only the path aliases.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Report fixtures load as base64 data URLs (`?inline`): lint keeps node:fs
  // out of tests.
  assetsInclude: ["**/*.xlsx", "**/*.zip"],
  test: {
    // Two workers, isolation kept on. Vitest's default on CI's
    // 2 vCPU is one worker, which ran the files one at a time. Turning
    // isolation off saves 18 s but leaks happy-dom documents between files
    // (#171).
    maxWorkers: 2,
    testTimeout,
    // Decision: the row budgets run with the unit tests in pnpm check and CI
    // (apps/dashboard/docs/adr/0012-row-budgets-run-with-the-unit-tests.md)
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, ROW_BUDGETS],
        },
      },
      {
        extends: true,
        test: {
          name: "row-budgets",
          include: [ROW_BUDGETS],
          exclude: [...configDefaults.exclude, WHOLE_DAY],
        },
      },
      { extends: true, test: { name: "whole-day", include: [WHOLE_DAY] } },
    ],
  },
})
