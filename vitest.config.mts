import { configDefaults, defineConfig } from "vitest/config"

// repos/ holds read-only vendored sources with suites of their own.
// The //#test:repo tests each spawn a turbo dry run, which takes
// over 5 s on a 2-core runner while check:static's vp check and build share
// the same `turbo run`, so the timeout is 30 s, not Vitest's default 5 s.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "repos/**"],
    testTimeout: 30_000,
  },
})
