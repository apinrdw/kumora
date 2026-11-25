// Parsed above-1% months at the parse's caps (ADR 0045: 15,000 rows a
// month, an investor name of 256 characters and other text of 128), written
// straight into a memory HoldingsDb, for the reads' bounded-memory tests.
// Every other month renames each holder, so each month's every holder is
// New and the month before's every holder is Off list: the most Holder
// moves lines a month can have.
import type { MemoryD1 } from "../memory-d1.ts"

export const ABOVE_1_MONTH_ROWS = 15_000

// `text` padded to `length` characters.
const padded = (text: string, length: number) => text.padEnd(length, "X")

// `count` report months' dates, the 28th of each month from Jan 2025.
export const monthsOf = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2025, index, 28)).toISOString().slice(0, 10)
  )

// `dates`' months, each with `stocks` stocks of `holders` holders each, a
// row each.
export const seedAbove1AtCap = (
  { database }: Pick<MemoryD1, "database">,
  dates: ReadonlyArray<string>,
  stocks: ReadonlyArray<string>,
  holders: number
) => {
  const month = database.prepare(
    "INSERT INTO above_1_month VALUES (?, 'sha', 1, '2026-11-25T00:00:00Z')"
  )
  const holding = database.prepare(
    `INSERT INTO above_1_holding VALUES
      (?, ?, ?, ?, ?, ?, NULL, 'CP', 'foreign', ?, ?, NULL, ?, 0, ?, ?)`
  )
  database.exec("BEGIN")
  dates.forEach((date, at) => {
    month.run(date)
    const renamed = at % 2 === 1 ? "Y" : "X"
    for (const code of stocks)
      for (let seq = 1; seq <= holders; seq++) {
        const name = padded(`HOLDER ${code} ${seq} `, 255) + renamed
        const shares = 1_000_000 + at * 100 + seq
        holding.run(
          date,
          code,
          seq,
          padded(`ISSUER ${code}`, 128),
          name,
          name,
          padded("NATIONALITY", 128),
          padded("DOMICILE", 128),
          shares,
          shares,
          100 + seq
        )
      }
  })
  database.exec("COMMIT")
}
