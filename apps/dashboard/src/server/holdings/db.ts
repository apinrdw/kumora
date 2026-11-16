// HoldingsDb, the parsed holdings D1 (HOLDINGS_DB in alchemy.run.ts; schema
// in holdings-migrations/). Code reaches it only through `batch`, which runs
// its statements in order as one transaction, as D1's `batch` does. Tests
// provide an in-memory SQLite one.
import { WorkerEnv } from "@workspace/server"
import { Context, Effect, Layer, Schema } from "effect"

import { d1Batch, type D1Binding, type Statement } from "../d1.ts"

export class HoldingsDbError extends Schema.TaggedError<HoldingsDbError>()(
  "HoldingsDbError",
  { cause: Schema.Defect() }
) {}

export class HoldingsDb extends Context.Service<
  HoldingsDb,
  {
    // Each statement's rows, in order. A failing statement rolls back the
    // whole batch.
    readonly batch: (
      statements: ReadonlyArray<Statement>
    ) => Effect.Effect<
      ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
      HoldingsDbError
    >
  }
>()("dashboard/holdings/HoldingsDb") {}

const overD1 = <Prepared>(db: D1Binding<Prepared>) =>
  HoldingsDb.of({
    batch: (statements) =>
      Effect.map(
        d1Batch(db, statements, (cause) => new HoldingsDbError({ cause })),
        ({ rows }) => rows
      ),
  })

export const holdingsDbD1 = Layer.effect(
  HoldingsDb,
  Effect.gen(function* () {
    return overD1((yield* WorkerEnv).HOLDINGS_DB)
  })
)
