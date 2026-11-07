// The one entry point for root scripts. A typed failure prints its message
// only, like a plain console.error line; a defect prints the full Cause with
// its stack. Both go to stderr and exit 1, and an interrupt exits 130.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, References } from "effect"

const report = <E,>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  if (Cause.hasDies(cause) || !Cause.hasFails(cause))
    return Effect.logError(cause)
  return Effect.forEach(
    cause.reasons.filter(Cause.isFailReason),
    (reason) => Console.error(errorMessage(reason.error)),
    { discard: true }
  )
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

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
