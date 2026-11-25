// WaitlistDb, the waitlist D1 (WAITLIST_DB in alchemy.run.ts; schema in
// waitlist-migrations/). Code reaches it only through `batch`, which runs its
// statements in order as one transaction, as D1's `batch` does. Tests provide
// an in-memory SQLite one.
import { WorkerEnv } from "@workspace/server"
import { d1Batch, type Statement } from "@workspace/server/d1"
import { Context, Effect, Layer, Schema } from "effect"

export class WaitlistDbError extends Schema.TaggedError<WaitlistDbError>()(
  "WaitlistDbError",
  { cause: Schema.Defect() }
) {}

export class WaitlistDb extends Context.Service<
  WaitlistDb,
  {
    // Each statement's rows, in order. A failing statement rolls back the
    // whole batch.
    readonly batch: (
      statements: ReadonlyArray<Statement>
    ) => Effect.Effect<
      ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
      WaitlistDbError
    >
  }
>()("web/waitlist/WaitlistDb") {}

export const waitlistDbD1 = Layer.effect(
  WaitlistDb,
  Effect.gen(function* () {
    const db = (yield* WorkerEnv).WAITLIST_DB
    return WaitlistDb.of({
      batch: (statements) =>
        d1Batch(db, statements, (cause) => new WaitlistDbError({ cause })).pipe(
          Effect.map(({ rows }) => rows)
        ),
    })
  })
)
