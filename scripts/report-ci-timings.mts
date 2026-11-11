import { Effect } from "effect"
import { Stdio } from "effect/Stdio"

import { ciTimings } from "./ci-timings.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* ciTimings(yield* repoRoot, args)
  })
)
