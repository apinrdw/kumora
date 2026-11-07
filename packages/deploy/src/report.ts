// How an entry point's failures reach the operator: all on stderr, so the
// teardown job's stdout (its $GITHUB_OUTPUT) only ever holds the Stage.
import * as Cause from "effect/Cause"
import { CliError, CliOutput } from "effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

// A typed failure prints its message only, like a plain console.error line;
// a defect prints the full Cause with its stack. effect/cli has already
// presented its own parse errors, so they print nothing more.
const reportCause = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  if (Cause.hasDies(cause) || !Cause.hasFails(cause))
    return Effect.logError(cause)
  return Effect.forEach(
    cause.reasons.filter(Cause.isFailReason),
    (reason) =>
      CliError.isCliError(reason.error)
        ? Effect.void
        : Console.error(errorMessage(reason.error)),
    { discard: true }
  )
}

export const report = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.tapCause(program, reportCause)

// effect/cli prints a bad invocation's usage to stdout by default.
export const stderrPresenter = CliOutput.layerPresenter({
  present: (event) =>
    event._tag === "InvalidInvocation"
      ? Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter
          yield* Console.error(formatter.formatHelpDoc(event.helpDoc))
          yield* Console.error(formatter.formatErrors(event.errors))
        })
      : CliOutput.defaultPresenter.present(event),
})
