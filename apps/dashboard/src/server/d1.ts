// A D1 batch as the dashboard's D1 services run it (HoldingsDb,
// BrokerTotalsDb): statements in order, as one transaction, each one's rows
// and the rows the batch wrote, as D1 bills them.
import { Effect } from "effect"

export type SqlValue = string | number | null

export interface Statement {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}

export interface D1Batch {
  readonly rows: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
  readonly rowsWritten: number
}

// The binding's members a batch uses, over its own statement type. The
// tests' typecheck has no Workers types; D1Database meets this shape under
// them.
export interface D1Binding<Prepared> {
  readonly prepare: (query: string) => {
    readonly bind: (...values: Array<unknown>) => Prepared
  }
  readonly batch: (statements: Array<Prepared>) => Promise<
    ReadonlyArray<{
      readonly results: ReadonlyArray<unknown>
      readonly meta: { readonly rows_written: number }
    }>
  >
}

export const d1Batch = <Prepared, E>(
  db: D1Binding<Prepared>,
  statements: ReadonlyArray<Statement>,
  failed: (cause: unknown) => E
) =>
  Effect.tryPromise({
    try: () =>
      db.batch(
        statements.map(({ sql, params }) => db.prepare(sql).bind(...params))
      ),
    catch: failed,
  }).pipe(
    Effect.map((results): D1Batch => ({
      rows: results.map(
        ({ results: rows }) => rows as ReadonlyArray<Record<string, unknown>>
      ),
      rowsWritten: results.reduce(
        (sum, { meta }) => sum + meta.rows_written,
        0
      ),
    }))
  )
