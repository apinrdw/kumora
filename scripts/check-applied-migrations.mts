import { Effect } from "effect"

import { checkAppliedMigrations } from "./applied-migrations.mts"
import { baseRef } from "./extension-version.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(
  Effect.gen(function* () {
    yield* checkAppliedMigrations(yield* repoRoot, yield* baseRef)
  })
)
