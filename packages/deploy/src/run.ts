// The one entry point for deploy and teardown. Failures print to stderr (see
// report.ts) and exit 1, and an interrupt exits 130. Its layers do no I/O
// until a command uses them, so deploy never reads GitHub or the state store.
import { BunServices } from "@effect/platform-bun"
import * as PlatformServices from "alchemy/Util/PlatformServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as References from "effect/References"

import { report, stderrPresenter } from "./report.ts"
import { GitHub } from "./github.ts"
import { Stacks } from "./stacks.ts"
import { StoredStages } from "./stored-stages.ts"

export const runMain = <A, E>(
  program: Effect.Effect<
    A,
    E,
    BunServices.BunServices | Stacks | StoredStages | GitHub
  >
) =>
  program.pipe(
    report,
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        Stacks.layer,
        StoredStages.layer,
        GitHub.layer,
        stderrPresenter
      )
    ),
    // runMain's own report would log to stdout; report() owns reporting.
    Effect.provideService(References.LogToStderr, true),
    // Alchemy's runner exits once the program ends, even on success, so a
    // provider's keep-alive socket cannot hold the process open.
    (main) => PlatformServices.runMain(main, { disableErrorReporting: true })
  )
