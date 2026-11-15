// Replacing one month of parsed holdings: every row of its date in each of
// its tables, then its month record, in one HoldingsDb batch, which D1 runs
// as one transaction. A reader sees the old month or the new one, never a
// mix, a failed batch leaves the old month whole, and a retry gives the same
// rows. Spec apinrdw/kumora#363, "Month replace".
import { Effect } from "effect"

import { HoldingsDb, type SqlValue, type Statement } from "./db.ts"

// Decision: a month lists at most 2,000 stocks in either report, about 2×
// the 962 IDX's classification report and the 1,005 KSEI's file listed in
// Sep and Oct 2026, so a parsed month's rows stay under 48 MiB on the heap
// (tests/server/holdings/classification.test.ts). Each report refuses a
// file listing more.
export const MAX_STOCKS = 2_000

// A month's rows for one table, each row its `columns` in order, without
// the date. Table and column names come from code, never from a file.
export interface MonthRows {
  readonly table: string
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<SqlValue>>
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

// Decision: rows go in 1,000 at a time, each chunk one INSERT … SELECT over
// json_each of one bound JSON array (~45 KB), under D1's 100 bound
// parameters and 100 KB per statement. See apinrdw/kumora#355.
const CHUNK_ROWS = 1000

const inserts = (dateColumn: string, date: string, rows: MonthRows) =>
  Effect.sync(() => {
    const sql =
      `INSERT INTO ${rows.table} (${[dateColumn, ...rows.columns].join(", ")}) ` +
      `SELECT ?, ${rows.columns.map((_, index) => `value->>${index}`).join(", ")} ` +
      "FROM json_each(?)"
    const statements: Array<Statement> = []
    for (let start = 0; start < rows.rows.length; start += CHUNK_ROWS)
      statements.push({
        sql,
        params: [
          date,
          JSON.stringify(rows.rows.slice(start, start + CHUNK_ROWS)),
        ],
      })
    return statements
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
