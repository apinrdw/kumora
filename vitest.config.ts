import { configDefaults, defineConfig } from "vitest/config"

// repos/ holds read-only vendored sources with suites of their own.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "repos/**"] },
})
