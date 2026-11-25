// Parsed above-5% days at the parse's caps (ADR 0045: 8,000 rows a day,
// names of 256 characters and other text of 128), written straight into a
// memory HoldingsDb, for the reads' bounded-memory tests. Each row is a
// block of one account, the most objects a day's rows make, and every
// block's shares differ from the day before's, so every stock moves.
import type { MemoryD1 } from "../memory-d1.ts"

export const ABOVE_5_DAY_ROWS = 8_000

// `text` padded to `length` characters.
const padded = (text: string, length: number) => text.padEnd(length, "X")

// `dates`' days, each with `stocks` stocks of `blocks` blocks each.
export const seedAbove5AtCap = (
  db: Pick<MemoryD1, "database">,
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

// `dates`' days of the stock `code`, each with `holders` holders no other
// day has, each of `accounts` accounts: every day's holders are New and the
// day before's Off list, and every holder before those is an earlier one, so
// the stock has the most earlier holders its days can.
export const seedAbove5Churn = (
  { database }: Pick<MemoryD1, "database">,
  dates: ReadonlyArray<string>,
  code: string,
  holders: number,
  accounts: number
) => {
  const day = database.prepare(
    "INSERT INTO above_5_day VALUES (?, 'sha', 1, '2026-11-25T00:00:00Z')"
  )
  const holder = database.prepare(
    "INSERT INTO above_5_holder VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
  const account = database.prepare(
    "INSERT INTO above_5_account VALUES (?, ?, ?, ?, ?, ?, 'foreign', ?, ?, ?)"
  )
  database.exec("BEGIN")
  dates.forEach((date, at) => {
    day.run(date)
    for (let no = 1; no <= holders; no++) {
      const name = `HOLDER ${at} ${no}`
      const shares = 1_000_000 + at * 100_000 + no
      holder.run(
        date,
        code,
        no,
        padded(`ISSUER ${code}`, 128),
        padded(name, 256),
        padded(name, 128),
        shares * accounts,
        500 + no
      )
      for (let ordinal = 1; ordinal <= accounts; ordinal++)
        account.run(
          date,
          code,
          no,
          ordinal,
          padded(`CUSTODIAN ${no} ${ordinal}`, 128),
          padded(`${name} ${ordinal}`, 256),
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

// Every other day of `dates`, each holder's name, key and account renamed
// (the last X a Y) with shares no holder of the day before has, so each
// day's every holder is New and the day before's every holder is Off list:
// the most Holder moves lines a day can have.
export const renameEveryOtherDay = (
  { database }: Pick<MemoryD1, "database">,
  dates: ReadonlyArray<string>
) => {
  const odd = JSON.stringify(dates.filter((_, at) => at % 2 === 1))
  database
    .prepare(
      `UPDATE above_5_holder SET
        holder_name = substr(holder_name, 1, length(holder_name) - 1) || 'Y',
        holder_key = substr(holder_key, 1, length(holder_key) - 1) || 'Y',
        scripless = scripless + 500000
      WHERE data_date IN (SELECT value FROM json_each(?))`
    )
    .run(odd)
  database
    .prepare(
      `UPDATE above_5_account SET
        account_name = substr(account_name, 1, length(account_name) - 1) || 'Y',
        scripless = scripless + 500000
      WHERE data_date IN (SELECT value FROM json_each(?))`
    )
    .run(odd)
}
