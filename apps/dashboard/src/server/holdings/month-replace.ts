// Replacing one month of parsed holdings: every row of its date in each of
// its tables, then its month record, in one HoldingsDb batch, which D1 runs
// as one transaction. A reader sees the old month or the new one, never a
// mix, a failed batch leaves the old month whole, and a retry gives the same
// rows. Spec apinrdw/kumora#363, "Month replace".
import { Effect } from "effect"

import { HoldingsDb, type SqlValue, type Statement } from "./db.ts"

// Decision: a month lists at most 2,000 stocks in any report, about 2× what
// each listed in Sep and Oct 2026 (962 in IDX's classification report,
// 1,005 in KSEI's Securities holdings report), so each of the three parses,
// investor-type included, stays under PARSE_HEAP_MIB
// (tests/server/holdings/bounded-heap.ts).
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

// Decision: rows go in at most 1,000 and 90,000 bytes of JSON at a time,
// each chunk one INSERT … SELECT over json_each of one bound JSON array,
// under D1's 100 bound parameters and 100 KB per statement: 1,000 rows of
// issuer names at their 256 characters, each written as \u0001, took 1.55 MB.
// See apinrdw/kumora#355.
const CHUNK_ROWS = 1000
const CHUNK_BYTES = 90_000

const encoder = new TextEncoder()

// Gathers a table's rows as a parse reads them, each chunk of them turned
// into one JSON array as soon as it is full.
// Decision: a parse holds its month as JSON text, about 35 bytes a row,
// not as an array a row, about 100: a classification report's 234,000
// holdings took 8 MiB as JSON and 22 MiB as arrays.
export const monthRows = (table: string, columns: ReadonlyArray<string>) =>
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
      // The rows added so far.
      gathered: Effect.sync((): MonthRows => ({
        table,
        columns,
        chunks: rows.length === 0 ? chunks : [...chunks, `[${rows.join(",")}]`],
      })),
    }
  })

const inserts = (dateColumn: string, date: string, rows: MonthRows) =>
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
