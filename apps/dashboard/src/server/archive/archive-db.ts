// ArchiveDb, the D1 both archives keep their metadata in (ARCHIVE_DB in
// alchemy.run.ts; schema in archive-migrations/): the report index
// (report-index.ts). Code reaches it only through `batch`, which runs its
// statements in order as one transaction, as D1's `batch` does. Tests provide
// an in-memory SQLite one.
import { WorkerEnv } from "@workspace/server"
import { Context, Effect, Layer, Schema } from "effect"

import { d1Batch, type D1Binding, type Statement } from "../d1.ts"

export class ArchiveDbError extends Schema.TaggedError<ArchiveDbError>()(
  "ArchiveDbError",
  { cause: Schema.Defect() }
) {}

export class ArchiveDb extends Context.Service<
  ArchiveDb,
  {
    // Each statement's rows, in order. A failing statement rolls back the
    // whole batch.
    readonly batch: (
      statements: ReadonlyArray<Statement>
    ) => Effect.Effect<
      ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
      ArchiveDbError
    >
  }
>()("dashboard/archive/ArchiveDb") {}

const overD1 = <Prepared>(db: D1Binding<Prepared>) =>
  ArchiveDb.of({
    batch: (statements) =>
      Effect.map(
        d1Batch(db, statements, (cause) => new ArchiveDbError({ cause })),
        ({ rows }) => rows
      ),
  })

export const archiveDbD1 = Layer.effect(
  ArchiveDb,
  Effect.gen(function* () {
    return overD1((yield* WorkerEnv).ARCHIVE_DB)
  })
)
