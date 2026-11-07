// The one entry point for deploy and teardown. Failures print to stderr (see
// report.ts) and exit 1, and an interrupt exits 130.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as References from "effect/References"

import { report, stderrPresenter } from "./report.ts"
import { Stacks } from "./stacks.ts"

export const runMain = <A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices | Stacks>
) =>
  program.pipe(
    report,
    Effect.provide(
      Layer.mergeAll(BunServices.layer, Stacks.layer, stderrPresenter)
    ),
    // runMain's own report would log to stdout; report() owns reporting.
    Effect.provideService(References.LogToStderr, true),
    BunRuntime.runMain({ disableErrorReporting: true })
  )
