import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkReleaseTag, wibDate } from "./release-tag.mts"

// node scripts/judge-release-tag.mts <tag> <push|release>
runScript(
  Effect.gen(function* () {
    yield* checkReleaseTag(
      yield* repoRoot,
      process.argv[2] ?? "",
      process.argv[3] === "release" ? undefined : yield* wibDate(new Date())
    )
  })
)
