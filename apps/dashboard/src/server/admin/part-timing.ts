// One Workers Logs line per part of an admin page's load, with its wall time,
// so the logs say which part makes the page slow. The Workers clock moves
// only across I/O, so a part's time is its waits, not its CPU.
import { Duration, Effect } from "effect"

export const timePart =
  (page: string, part: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.timed(self).pipe(
      Effect.flatMap(([duration, result]) =>
        Effect.logInfo("Admin page part timed").pipe(
          Effect.annotateLogs({ page, part, ms: Duration.toMillis(duration) }),
          Effect.as(result)
        )
      )
    )
