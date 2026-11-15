// Seeds the Test stage's parsed holdings (the HoldingsDb local D1) with a few
// KSEI months, as the KSEI parse run would leave them. The stock page only
// reads these rows.
import { DatabaseSync } from "node:sqlite"

import { databaseFile, databaseId } from "./local-d1"

type TypeShares = Readonly<Record<string, number>>

/** A stock's period end: shares by KSEI investor type, in each origin. */
export interface SeededKseiStockMonth {
  readonly listedShares: number
  readonly price: number
  readonly local: TypeShares
  readonly foreign: TypeShares
}

/** Stock-months by period end, then by stock code. */
export type SeededKseiMonths = Readonly<
  Record<string, Readonly<Record<string, SeededKseiStockMonth>>>
>

const sum = (shares: TypeShares) =>
  Object.values(shares).reduce((total, each) => total + each, 0)

/** Replaces every parsed KSEI month with `months`. */
export function seedKseiMonths(months: SeededKseiMonths) {
  const id = databaseId("HoldingsDb")
  if (id === undefined) throw new Error("The Test stage has no HoldingsDb yet")
  // The dashboard holds the file open too: wait out its locks.
  const db = new DatabaseSync(databaseFile(id).pathname, { timeout: 5000 })
  try {
    db.exec("BEGIN")
    for (const table of ["ksei_holding", "ksei_stock_month", "ksei_month"])
      db.exec(`DELETE FROM ${table}`)
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
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}
