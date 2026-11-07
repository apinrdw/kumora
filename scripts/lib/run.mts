// The one entry point for root scripts. A typed failure prints its message
// only, like a plain console.error line; a defect prints the full Cause with
// its stack. Both go to stderr and exit 1, and an interrupt exits 130.
// packages/deploy/src/report.ts reports the same way for deploy and teardown;
// the workspaces share no module, so a change here belongs there too.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, References } from "effect"

const errorMessage = Effect.fnUntraced(function* (error: unknown) {
  return error instanceof Error ? error.message : String(error)
})

const report = Effect.fnUntraced(function* <E>(cause: Cause.Cause<E>) {
  if (Cause.hasInterruptsOnly(cause)) return
  if (Cause.hasDies(cause) || !Cause.hasFails(cause))
    return yield* Effect.logError(cause)
  yield* Effect.forEach(
    cause.reasons.filter(Cause.isFailReason),
    (reason) => Effect.flatMap(errorMessage(reason.error), Console.error),
    { discard: true }
  )
})

export const runScript = <A, E>(
  program: Effect.Effect<A, E, NodeServices.NodeServices>
) =>
  program.pipe(
    Effect.tapCause(report),
    Effect.provide(NodeServices.layer),
    // runMain's own report would log to stdout; this one owns reporting.
    Effect.provideService(References.LogToStderr, true),
    NodeRuntime.runMain({ disableErrorReporting: true })
  )
