// Runs before the apps start (playwright.config.ts). Each e2e run starts with
// an empty local D1: without the Test stage's Alchemy state, `alchemy dev`
// creates a new local database (and signing secret) and applies the
// migrations to it. The Dev stage's state is left alone.
import { rmSync } from "node:fs"

rmSync(
  new URL("../dashboard/.alchemy/state/kumora-dashboard/test", import.meta.url),
  { recursive: true, force: true }
)
