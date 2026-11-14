import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkReleaseTag, wibDate } from "./release-tag.mts"

runScript(
  Effect.gen(function* () {
    yield* checkReleaseTag(
      yield* repoRoot,
      process.argv[2] ?? "",
      wibDate(new Date())
    )
  })
)
