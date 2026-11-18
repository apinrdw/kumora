import { configDefaults, defineConfig } from "vitest/config"

import { testTimeout } from "../../vitest.timeout.mts"

// The row budgets (tests/server/market-live/row-budgets.workerd.test.ts) run
// the day object in workerd; `pnpm --filter dashboard test:row-budgets` runs
// them alone.
const ROW_BUDGETS = "tests/**/*.workerd.test.ts"
// Decision: the whole busy day records for about 280 s in workerd, so it is a
// project of its own that `pnpm --filter dashboard test:whole-day` runs, left
// out of `pnpm check` and CI. A change to what a day writes or stores runs
// it, and its PR reports the figures (spec apinrdw/kumora#555).
const WHOLE_DAY = "tests/**/whole-day.workerd.test.ts"

// Tests run in Node without vite.config.ts and its TanStack Start plugins.
// Vite transforms JSX on its own, so the suites need only the path aliases.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Report fixtures load as base64 data URLs (`?inline`): lint keeps node:fs
  // out of tests.
  assetsInclude: ["**/*.xlsx", "**/*.zip"],
  test: {
    // Decision: two workers, isolation kept on. Vitest's default on CI's
    // 2 vCPU is one worker, which ran the files one at a time. Turning
    // isolation off saves 18 s but leaks happy-dom documents between files
    // (#171).
    maxWorkers: 2,
    testTimeout,
    // Decision: the row budgets are a project of the dashboard's tests, so
    // `pnpm check` and CI's unit-tests job run them with the rest.
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
