// A script for run.test.mts: argv picks how it ends.
import { Console, Effect, Stdio } from "effect"

import { CheckFailed } from "./check.mts"
import { runScript } from "./run.mts"

runScript(
  Effect.gen(function* () {
    const [outcome] = yield* (yield* Stdio.Stdio).args
    if (outcome === "fail")
      return yield* new CheckFailed({
        summary: "Two things are wrong:",
        findings: ["first", "second"],
      })
    if (outcome === "die") return yield* Effect.die(new Error("boom"))
    yield* Console.log("done")
  })
)
