// Replacing one month of parsed holdings: every row of its date in each of
// its tables, then its month record, in one HoldingsDb batch, which D1 runs
// as one transaction. A reader sees the old month or the new one, never a
// mix, a failed batch leaves the old month whole, and a retry gives the same
// rows. Spec apinrdw/kumora#363, "Month replace".
import { Effect } from "effect"

import { jsonChunker, type SqlValue, type Statement } from "../d1.ts"
import { HoldingsDb } from "./db.ts"

// Decision: a report's parse is bounded to fit 48 MiB of the Worker's heap
// (apps/dashboard/docs/adr/0045-a-holdings-parse-fits-a-bounded-heap.md)
export const MAX_STOCKS = 2_000

// Why a parse refuses a report listing more.
export const TOO_MANY_STOCKS = `The report lists more than ${MAX_STOCKS.toLocaleString("en-US")} stocks`

// A month's rows for one table, without the date, as JSON arrays of at most
// CHUNK_ROWS rows and CHUNK_BYTES bytes, each row its `columns` in order. Table and column names
// come from code, never from a file.
export interface MonthRows {
  readonly table: string
  readonly columns: ReadonlyArray<string>
  readonly chunks: ReadonlyArray<string>
}

export interface MonthReplace {
  // The column every table keys its month by, and the month's value of it.
  readonly dateColumn: string
  readonly date: string
  readonly tables: ReadonlyArray<MonthRows>
  // Upserted last, keyed by `dateColumn`.
  readonly record: {
    readonly table: string
    readonly values: Readonly<Record<string, SqlValue>>
  }
}

// Gathers a table's rows as a parse reads them, each chunk of them turned
// into one JSON array as soon as it is full.
// A parse holds its month as JSON text, about 35 bytes a row,
// not as an array a row, about 100: a classification report's 234,000
// holdings took 8 MiB as JSON and 22 MiB as arrays.
// Decision: D1 inserts go in json_each chunks under D1's statement limits
// (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
export const monthRows = Effect.fnUntraced(function* (
  table: string,
  columns: ReadonlyArray<string>
) {
  const chunker = yield* jsonChunker()
  return {
    add: chunker.add,
    // The rows added so far.
    gathered: Effect.map(chunker.chunks, (chunks): MonthRows => ({
      table,
      columns,
      chunks,
    })),
  }
})

// The statements inserting `rows`, each with `date` in `dateColumn`.
export const inserts = (dateColumn: string, date: string, rows: MonthRows) =>
  Effect.sync(() => {
    const sql =
      `INSERT INTO ${rows.table} (${[dateColumn, ...rows.columns].join(", ")}) ` +
      `SELECT ?, ${rows.columns.map((_, index) => `value->>${index}`).join(", ")} ` +
      "FROM json_each(?)"
    return rows.chunks.map((chunk): Statement => ({
      sql,
      params: [date, chunk],
    }))
  })

export const replaceMonth = Effect.fnUntraced(function* ({
  dateColumn,
  date,
  tables,
  record,
}: MonthReplace) {
  const recordColumns = Object.keys(record.values)
  const rowInserts: Array<Statement> = []
  for (const rows of tables)
    rowInserts.push(...(yield* inserts(dateColumn, date, rows)))
  yield* (yield* HoldingsDb).batch([
    ...tables.map(({ table }) => ({
      sql: `DELETE FROM ${table} WHERE ${dateColumn} = ?`,
      params: [date],
    })),
    ...rowInserts,
    {
      sql:
        `INSERT INTO ${record.table} (${[dateColumn, ...recordColumns].join(", ")}) ` +
        `VALUES (${["?", ...recordColumns.map(() => "?")].join(", ")}) ` +
        `ON CONFLICT (${dateColumn}) DO UPDATE SET ` +
        recordColumns
          .map((column) => `${column} = excluded.${column}`)
          .join(", "),
      params: [
        date,
        ...recordColumns.map((column) => record.values[column] ?? null),
      ],
    },
  ])
})
