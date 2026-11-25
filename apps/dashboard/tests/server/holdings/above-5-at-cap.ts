// Parsed above-5% days at the parse's caps (ADR 0045: 8,000 rows a day,
// names of 256 characters and other text of 128), written straight into a
// memory HoldingsDb, for the reads' bounded-memory tests. Each row is a
// block of one account, the most objects a day's rows make, and every
// block's shares differ from the day before's, so every stock moves.
import type { MemoryHoldingsDb } from "./memory-holdings-db.ts"

export const ABOVE_5_DAY_ROWS = 8_000

// `text` padded to `length` characters.
const padded = (text: string, length: number) => text.padEnd(length, "X")

// `dates`' days, each with `stocks` stocks of `blocks` blocks each.
export const seedAbove5AtCap = (
  db: MemoryHoldingsDb,
  dates: ReadonlyArray<string>,
  stocks: ReadonlyArray<string>,
  blocks: number
) => {
  const { database } = db
  const day = database.prepare(
    "INSERT INTO above_5_day VALUES (?, 'sha', 1, '2026-11-25T00:00:00Z')"
  )
  const holder = database.prepare(
    "INSERT INTO above_5_holder VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
  const account = database.prepare(
    "INSERT INTO above_5_account VALUES (?, ?, ?, 1, ?, ?, 'foreign', ?, ?, ?)"
  )
  database.exec("BEGIN")
  dates.forEach((date, at) => {
    day.run(date)
    let no = 0
    for (const code of stocks)
      for (let place = 0; place < blocks; place++) {
        no += 1
        const name = padded(`HOLDER ${code} ${place}`, 256)
        const shares = 1_000_000 + at * 100 + place
        holder.run(
          date,
          code,
          no,
          padded(`ISSUER ${code}`, 128),
          name,
          padded(`HOLDER ${code} ${place}`, 128),
          shares,
          500 + place
        )
        account.run(
          date,
          code,
          no,
          padded(`CUSTODIAN ${place}`, 128),
          name,
          padded("NATIONALITY", 128),
          padded("DOMICILE", 128),
          shares
        )
      }
  })
  database.exec("COMMIT")
}

// `count` trading days' dates from 2026-01-01, one a calendar day.
export const datesOf = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
  )
