// HoldingsDb, the parsed holdings D1 (HOLDINGS_DB in alchemy.run.ts; schema
// in holdings-migrations/). Code reaches it only through `batch`, which runs
// its statements in order as one transaction, as D1's `batch` does. Tests
// provide an in-memory SQLite one.
import { WorkerEnv } from "@workspace/server"
import { Context, Effect, Layer, Schema } from "effect"

export type SqlValue = string | number | null

export interface Statement {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}

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

// The binding's members this layer uses, over its own statement type. The
// tests' typecheck has no Workers types; D1Database meets this shape under
// them.
interface D1Binding<Prepared> {
  readonly prepare: (query: string) => {
    readonly bind: (...values: Array<unknown>) => Prepared
  }
  readonly batch: (
    statements: Array<Prepared>
  ) => Promise<ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>>
}

const overD1 = <Prepared>(db: D1Binding<Prepared>) =>
  HoldingsDb.of({
    batch: (statements) =>
      Effect.tryPromise({
        try: () =>
          db.batch(
            statements.map(({ sql, params }) => db.prepare(sql).bind(...params))
          ),
        catch: (cause) => new HoldingsDbError({ cause }),
      }).pipe(
        Effect.map((results) =>
          results.map(
            ({ results: rows }) =>
              rows as ReadonlyArray<Record<string, unknown>>
          )
        )
      ),
  })

export const holdingsDbD1 = Layer.effect(
  HoldingsDb,
  Effect.gen(function* () {
    return overD1((yield* WorkerEnv).HOLDINGS_DB)
  })
)
