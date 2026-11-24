// A D1 batch as the dashboard's D1 services run it (HoldingsDb,
// BrokerTotalsDb): statements in order, as one transaction, each one's rows
// and the rows the batch wrote, as D1 bills them.
import { Effect, Schema } from "effect"

export type SqlValue = string | number | null

export interface Statement {
  readonly sql: string
  readonly params: ReadonlyArray<SqlValue>
}

// The most rows, and bytes of JSON, one `INSERT … SELECT` over `json_each`
// takes.
// Decision: D1 inserts go in json_each chunks under D1's statement limits
// (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
const CHUNK_ROWS = 1000
const CHUNK_BYTES = 90_000

const encoder = new TextEncoder()

// Gathers rows, each an array of its columns, into JSON arrays of at most
// CHUNK_ROWS rows and CHUNK_BYTES bytes, each chunk turned into text as soon
// as it is full.
export const jsonChunker = () =>
  Effect.sync(() => {
    const chunks: Array<string> = []
    let rows: Array<string> = []
    // The bytes of `rows` as one JSON array.
    let bytes = 2
    return {
      add: (row: ReadonlyArray<SqlValue>) =>
        Effect.sync(() => {
          const json = JSON.stringify(row)
          const rowBytes = encoder.encode(json).length + 1
          const full =
            rows.length === CHUNK_ROWS || bytes + rowBytes > CHUNK_BYTES
          if (full && rows.length > 0) {
            chunks.push(`[${rows.join(",")}]`)
            rows = []
            bytes = 2
          }
          rows.push(json)
          bytes += rowBytes
        }),
      // The chunks of the rows added so far.
      chunks: Effect.sync(() =>
        rows.length === 0 ? chunks : [...chunks, `[${rows.join(",")}]`]
      ),
    }
  })

// `rows` as jsonChunker's chunks, for code that holds its rows already.
export const jsonChunks = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ReadonlyArray<SqlValue>>
) {
  const chunker = yield* jsonChunker()
  for (const row of rows) yield* chunker.add(row)
  return yield* chunker.chunks
})

// Decodes a statement's rows as `row`s. Rows that don't fit are a defect:
// the statement chose their columns.
export const decodeRows = <A, I>(row: Schema.Codec<A, I>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row))
  return (rows: ReadonlyArray<Record<string, unknown>>) =>
    decode(rows).pipe(Effect.orDie)
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
