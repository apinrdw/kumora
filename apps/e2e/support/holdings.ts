// Seeds the Test stage's parsed holdings (the HoldingsDb local D1) with a
// few classification and KSEI months, as the parse runs would leave
// them.
// The stock page only reads these rows.
import { DatabaseSync } from "node:sqlite"

import { databaseFile, databaseId } from "./local-d1"

type Shares = Readonly<Record<string, number>>

/** A stock's month: shares by classification, combined or local and foreign. */
export type SeededStockMonth =
  | { readonly issuer: string; readonly combined: Shares }
  | {
      readonly issuer: string
      readonly local: Shares
      readonly foreign: Shares
    }

/** Stock-months by data date, then by stock code. */
export type SeededMonths = Readonly<
  Record<string, Readonly<Record<string, SeededStockMonth>>>
>

const sum = (shares: Shares) =>
  Object.values(shares).reduce((total, each) => total + each, 0)

// The rows a parse stores: zeros skipped, and in a split month a combined
// row per classification holding local plus foreign.
const holdingRows = (month: SeededStockMonth) => {
  if ("combined" in month)
    return Object.entries(month.combined).map(
      ([classification, shares]) =>
        [classification, "combined", shares] as const
    )
  const combined = new Map<string, number>()
  for (const shares of [month.local, month.foreign])
    for (const [classification, held] of Object.entries(shares))
      combined.set(classification, (combined.get(classification) ?? 0) + held)
  return [
    ...Object.entries(month.local).map(([c, s]) => [c, "local", s] as const),
    ...Object.entries(month.foreign).map(
      ([c, s]) => [c, "foreign", s] as const
    ),
    ...[...combined].map(([c, s]) => [c, "combined", s] as const),
  ]
}

const total = (month: SeededStockMonth) =>
  "combined" in month
    ? sum(month.combined)
    : sum(month.local) + sum(month.foreign)

// Empties `tables` of the Test stage's HoldingsDb, then runs `fill`, in one
// transaction.
function replaceTables(
  tables: ReadonlyArray<string>,
  fill: (db: DatabaseSync) => void
) {
  const id = databaseId("HoldingsDb")
  if (id === undefined) throw new Error("The Test stage has no HoldingsDb yet")
  // The dashboard holds the file open too: wait out its locks.
  const db = new DatabaseSync(databaseFile(id).pathname, { timeout: 5000 })
  try {
    db.exec("BEGIN")
    for (const table of tables) db.exec(`DELETE FROM ${table}`)
    fill(db)
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

/** Replaces every parsed classification month with `months`. */
export function seedClassificationMonths(months: SeededMonths) {
  replaceTables(
    [
      "classification_holding",
      "classification_stock_month",
      "classification_month",
    ],
    (db) => {
      const record = db.prepare(
        "INSERT INTO classification_month (data_date, sha256, parser_version, parsed_at, split) VALUES (?, ?, 2, '2026-11-14T13:00:00.000Z', ?)"
      )
      const stock = db.prepare(
        "INSERT INTO classification_stock_month VALUES (?, ?, ?, ?)"
      )
      const holding = db.prepare(
        "INSERT INTO classification_holding VALUES (?, ?, ?, ?, ?)"
      )
      for (const [dataDate, stocks] of Object.entries(months)) {
        // A month's report splits when its stocks do.
        const split = Object.values(stocks).some(
          (month) => !("combined" in month)
        )
        record.run(dataDate, `sha-${dataDate}`, split ? 1 : 0)
        for (const [code, month] of Object.entries(stocks)) {
          stock.run(dataDate, code, month.issuer, total(month))
          for (const [classification, origin, shares] of holdingRows(month))
            holding.run(dataDate, code, classification, origin, shares)
        }
      }
    }
  )
}

/** A stock's KSEI period end: shares by investor type, in each origin. */
export interface SeededKseiStockMonth {
  readonly listedShares: number
  readonly price: number
  readonly local: Shares
  readonly foreign: Shares
}

/** KSEI stock-months by period end, then by stock code. */
export type SeededKseiMonths = Readonly<
  Record<string, Readonly<Record<string, SeededKseiStockMonth>>>
>

/** Replaces every parsed KSEI month with `months`. */
export function seedKseiMonths(months: SeededKseiMonths) {
  replaceTables(["ksei_holding", "ksei_stock_month", "ksei_month"], (db) => {
    const record = db.prepare(
      "INSERT INTO ksei_month VALUES (?, ?, 1, '2026-11-14T04:00:00.000Z')"
    )
    const stock = db.prepare(
      "INSERT INTO ksei_stock_month VALUES (?, ?, ?, ?, ?)"
    )
    const holding = db.prepare(
      "INSERT INTO ksei_holding VALUES (?, ?, ?, ?, ?)"
    )
    for (const [periodEnd, stocks] of Object.entries(months)) {
      record.run(periodEnd, `sha-${periodEnd}`)
      for (const [code, month] of Object.entries(stocks)) {
        stock.run(
          periodEnd,
          code,
          month.listedShares,
          month.price,
          sum(month.local) + sum(month.foreign)
        )
        for (const origin of ["local", "foreign"] as const)
          for (const [type, shares] of Object.entries(month[origin]))
            if (shares > 0) holding.run(periodEnd, code, origin, type, shares)
      }
    }
  })
}
