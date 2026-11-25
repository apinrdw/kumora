// IDX's daily "holders above 5%" report, parsed into above-5% holders and
// their accounts (holdings-migrations/0010_above_5.sql), one trading day per
// report. Strict over the whole day: any check that fails fails the day.
// Spec apinrdw/kumora#673, "Parser" and "Storage"; the report's facts are in
// apinrdw/kumora#670.
import { isTradingDay, STOCK_CODE_MAX_LENGTH, WibDate } from "@workspace/relay"
import { DateTime, Effect, Schema } from "effect"

import type { SqlValue } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import { excerpt } from "./excerpt.ts"
import { holderKey } from "./holder-key.ts"
import {
  MAX_STOCKS,
  monthRows,
  replaceMonth,
  TOO_MANY_STOCKS,
} from "./month-replace.ts"
import type { MonthTables } from "./months-to-parse.ts"
import {
  CellError,
  cellText,
  columnLetters,
  forEachRow,
  headerMismatch,
  type ReadRow,
} from "./xlsx.ts"

// Bumped whenever parsing changes what it stores, the holder key included:
// the above-5% parse run then parses every day again.
export const ABOVE_5_PARSER_VERSION = 1

class Above5Unreadable extends Schema.TaggedError<Above5Unreadable>()(
  "Above5Unreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) => new Above5Unreadable({ message })

// Decision: a report's parse is bounded to fit 48 MiB of the Worker's heap
// (apps/dashboard/docs/adr/0045-a-holdings-parse-fits-a-bounded-heap.md)
export const MAX_ROWS = 8_000
const MAX_NAME_LENGTH = 256
const MAX_TEXT_LENGTH = 128
// The integer cells one side of a block may leave ambiguous: each doubles
// the readings tried. The real reports leave at most 3.
const MAX_AMBIGUOUS = 8

const TITLE = "KEPEMILIKAN EFEK DIATAS 5% BERDASARKAN SID (PUBLIK) per tanggal"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

// The columns, 0-based from A.
const NO = 0
const CODE = 1
const ISSUER = 2
const CUSTODIAN = 3
const HOLDER = 4
const ACCOUNT = 5
const NATIONALITY = 8
const DOMICILE = 9
const STATUS = 10
const PREVIOUS = { shares: 11, combined: 12, percentage: 13 } as const
const CURRENT = { shares: 14, combined: 15, percentage: 16 } as const
const CHANGE = 17

type Side = typeof PREVIOUS | typeof CURRENT

// The investor-level columns, filled on a block's first row only.
const INVESTOR_COLUMNS = [
  NO,
  ISSUER,
  HOLDER,
  PREVIOUS.combined,
  PREVIOUS.percentage,
  CURRENT.combined,
  CURRENT.percentage,
]

const SHARES_LABEL = "Jumlah Saham"
const COMBINED_LABEL = "Saham Gabungan Per Investor"
const PERCENTAGE_LABEL = "Persentase Kepemilikan Per Investor (%)"

// What a header cell names, for a failure: its label and column.
const COLUMN_NAMES: ReadonlyMap<number, string> = new Map([
  [NO, "No"],
  [CODE, "Kode Efek"],
  [ISSUER, "Nama Emiten"],
  [CUSTODIAN, "Nama Pemegang Rekening Efek"],
  [HOLDER, "Nama Pemegang Saham"],
  [ACCOUNT, "Nama Rekening Efek"],
  [NATIONALITY, "Kebangsaan"],
  [DOMICILE, "Domisili"],
  [STATUS, "Status (Lokal/Asing)"],
  [PREVIOUS.shares, SHARES_LABEL],
  [PREVIOUS.combined, COMBINED_LABEL],
  [PREVIOUS.percentage, PERCENTAGE_LABEL],
  [CURRENT.shares, SHARES_LABEL],
  [CURRENT.combined, COMBINED_LABEL],
  [CURRENT.percentage, PERCENTAGE_LABEL],
  [CHANGE, "Perubahan"],
])

// The rows after the data, in order, each a text in A alone.
const LEGEND = [
  "Keterangan",
  "* Font:",
  "Hitam = tidak ada perubahan kepemilikan",
  "Biru = Ada perubahan persentase kepemilikan tetapi masih tetap diatas 5% dibandingkan hari sebelumnya",
]

const ORIGINS: ReadonlyMap<string, "local" | "foreign"> = new Map([
  ["L", "local"],
  ["A", "foreign"],
])

// 2026-11-20 as the title writes it, `20 Nov 2026`, and as the header does,
// `20-NOV-2026`.
const titleDate = (date: string) =>
  Effect.sync(
    () =>
      `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`
  )
const headerDate = (date: string) =>
  Effect.sync(
    () =>
      `${date.slice(8, 10)}-${(MONTHS[Number(date.slice(5, 7)) - 1] ?? "").toUpperCase()}-${date.slice(0, 4)}`
  )

// The trading day before `date`, by IDX's schedule.
const tradingDayBefore = Effect.fnUntraced(function* (date: string) {
  const day = DateTime.makeUnsafe(date)
  for (let days = 1; days <= 31; days++) {
    const before = WibDate.make(
      DateTime.formatIsoDate(DateTime.add(day, { days: -days }))
    )
    if (
      yield* isTradingDay(before).pipe(
        Effect.catchTag("ScheduleYearMissing", ({ year }) =>
          Effect.fail(
            unreadable(
              `IDX's trading schedule has no ${year}, so ${date}'s previous trading day is unknown`
            )
          )
        )
      )
    )
      return before
  }
  return yield* unreadable(`No trading day falls in the 31 days before ${date}`)
})

// A header row holding `labels`, from A.
// Decision: a report header must match a known layout exactly, or the day fails
// (apps/dashboard/docs/adr/0046-a-holdings-header-must-match-a-known-layout-exactly.md)
const checkLabels = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow,
  labels: ReadonlyArray<string>
) {
  const mismatch = yield* headerMismatch(rowNumber, cells, labels)
  if (mismatch !== undefined) return yield* unreadable(mismatch)
})

// A row holding only `text` in A.
const checkLone = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow,
  text: string,
  what: string
) {
  const found = yield* cellText(cells.get(NO))
  if (cells.size !== 1 || found !== text)
    return yield* unreadable(
      `Row ${rowNumber} isn't ${what}: ${yield* excerpt(found)}`
    )
})

// One side's reading of a share count: undefined for `-`, not listed that
// day; else every number it may be. IDX's export read 1,000–999,999 as
// decimal-comma numbers, so a fractional number cell is ×1000 and an integer
// one is itself or ×1000; a comma-separated text cell is exact.
type Readings = ReadonlyArray<number> | undefined

// A row's cells as a reader takes them: where it is, for a failure.
interface At {
  readonly cells: ReadRow
  readonly where: string
}

const nameOf = Effect.fnUntraced(function* (column: number) {
  return `${COLUMN_NAMES.get(column) ?? "?"} (${yield* columnLetters(column)})`
})

const failAt = Effect.fnUntraced(function* (
  at: At,
  column: number,
  what: string
) {
  return yield* unreadable(`${at.where}'s ${yield* nameOf(column)} ${what}`)
})

const SHARE_TEXT = /^\d{1,3}(?:,\d{3})*$/
const CHANGE_TEXT = /^-?\d{1,3}(?:,\d{3})*$/
const PERCENTAGE_TEXT = /^\d+\.\d{2}$/

// A text cell's readings; null when it is no count.
const textReadings = (text: string, signed: boolean) =>
  Effect.sync((): Readings | null => {
    if (text === "-") return undefined
    if (!(signed ? CHANGE_TEXT : SHARE_TEXT).test(text)) return null
    const value = Number(text.replaceAll(",", ""))
    return Number.isSafeInteger(value) ? [value] : null
  })

// A number cell's readings; null when it is no count.
const numberReadings = (value: number, signed: boolean) =>
  Effect.sync((): Readings | null => {
    if (!Number.isFinite(value) || (!signed && value < 0)) return null
    if (value === 0) return [0]
    if (Number.isInteger(value))
      return Number.isSafeInteger(value * 1000) ? [value, value * 1000] : null
    const thousands = Math.round(value * 1000)
    return Math.abs(thousands - value * 1000) < 1e-6 &&
      Number.isSafeInteger(thousands)
      ? [thousands]
      : null
  })

const readingsAt = Effect.fnUntraced(function* (
  at: At,
  column: number,
  signed: boolean
) {
  const cell = at.cells.get(column)
  if (cell instanceof CellError)
    return yield* failAt(
      at,
      column,
      `holds the error ${yield* excerpt(cell.text)}`
    )
  const readings =
    typeof cell === "string"
      ? yield* textReadings(cell.trim(), signed)
      : typeof cell === "number"
        ? yield* numberReadings(cell, signed)
        : null
  if (readings !== null) return readings
  return yield* failAt(
    at,
    column,
    `isn't a share count: ${yield* excerpt(yield* cellText(cell))}`
  )
})

// A percentage as hundredths, at least 5.00; undefined for `-`.
const percentageAt = Effect.fnUntraced(function* (at: At, column: number) {
  const cell = at.cells.get(column)
  const text = typeof cell === "string" ? cell.trim() : undefined
  if (text === "-") return undefined
  if (text === undefined || !PERCENTAGE_TEXT.test(text))
    return yield* failAt(
      at,
      column,
      `isn't a 2-decimal percentage: ${yield* excerpt(yield* cellText(cell))}`
    )
  const hundredths = Number(text.replace(".", ""))
  if (hundredths < 500) return yield* failAt(at, column, `is below 5%: ${text}`)
  return hundredths
})

// A text cell, trimmed; null when blank.
const textAt = Effect.fnUntraced(function* (
  at: At,
  column: number,
  max: number
) {
  const cell = at.cells.get(column)
  if (cell === undefined) return null
  if (typeof cell !== "string")
    return yield* failAt(
      at,
      column,
      `isn't text: ${yield* excerpt(yield* cellText(cell))}`
    )
  const text = cell.trim()
  if (text.length > max)
    return yield* failAt(at, column, `is over ${max} characters`)
  return text === "" ? null : text
})

const requiredTextAt = Effect.fnUntraced(function* (
  at: At,
  column: number,
  max: number
) {
  const text = yield* textAt(at, column, max)
  if (text === null) return yield* failAt(at, column, "is empty")
  return text
})

// One account row as read, its shares unresolved.
interface SecuritiesAccountRow {
  readonly at: At
  readonly custodian: string
  readonly accountName: string
  readonly origin: "local" | "foreign"
  readonly nationality: string | null
  readonly domicile: string | null
  readonly previous: Readings
  readonly current: Readings
  readonly change: Readings
}

// One block as read: an investor's first row's columns, then its accounts.
interface Block {
  readonly at: At
  // Its stock and holder, as a failure names them.
  readonly name: string
  readonly stock: string
  readonly no: number
  readonly issuer: string
  readonly holder: string
  readonly previous: {
    readonly combined: Readings
    readonly percentage: number | undefined
  }
  readonly current: {
    readonly combined: ReadonlyArray<number>
    readonly percentage: number
  }
  readonly accounts: Array<SecuritiesAccountRow>
}

const accountRow = Effect.fnUntraced(function* (at: At) {
  const status = yield* requiredTextAt(at, STATUS, MAX_TEXT_LENGTH)
  const origin = ORIGINS.get(status)
  if (origin === undefined)
    return yield* failAt(
      at,
      STATUS,
      `is neither L nor A: ${yield* excerpt(status)}`
    )
  return {
    at,
    custodian: yield* requiredTextAt(at, CUSTODIAN, MAX_NAME_LENGTH),
    accountName: yield* requiredTextAt(at, ACCOUNT, MAX_NAME_LENGTH),
    origin,
    nationality: yield* textAt(at, NATIONALITY, MAX_TEXT_LENGTH),
    domicile: yield* textAt(at, DOMICILE, MAX_TEXT_LENGTH),
    previous: yield* readingsAt(at, PREVIOUS.shares, false),
    current: yield* readingsAt(at, CURRENT.shares, false),
    change: yield* readingsAt(at, CHANGE, true),
  } satisfies SecuritiesAccountRow
})

// A reading of one side whose accounts sum to its combined shares.
interface Fit {
  readonly combined: number
  readonly shares: ReadonlyArray<number>
}

// Every combined reading of one side that its accounts' readings sum to, each
// with the accounts' shares; an account not listed that side holds 0.
const fits = Effect.fnUntraced(function* (
  block: Block,
  combined: ReadonlyArray<number>,
  accounts: ReadonlyArray<ReadonlyArray<number>>,
  column: number
) {
  const ambiguous = [combined, ...accounts].filter(
    (readings) => readings.length > 1
  ).length
  if (ambiguous > MAX_AMBIGUOUS)
    return yield* failAt(
      block.at,
      column,
      `leaves ${ambiguous} of its block's share counts ambiguous, over ${MAX_AMBIGUOUS}`
    )
  const found: Array<Fit> = []
  for (let choice = 0; choice < 2 ** ambiguous; choice++) {
    let bit = 0
    const pick = (readings: ReadonlyArray<number>) =>
      readings.length === 1
        ? (readings[0] ?? 0)
        : (readings[(choice >> bit++) & 1] ?? 0)
    const total = pick(combined)
    const shares = accounts.map(pick)
    if (shares.reduce((sum, each) => sum + each, 0) === total)
      found.push({ combined: total, shares })
  }
  return found
})

// `shares` as a % of `listed`, half up to 2 decimals, × 100.
const hundredthsOf = (shares: number, listed: number) =>
  Effect.sync(() =>
    Number((BigInt(shares) * 20_000n + BigInt(listed)) / (2n * BigInt(listed)))
  )

// The stock's listed shares in force on a day, from the latest parsed
// investor-type report on or before it; undefined when none lists it.
type ListedOn = (
  stock: string
) => Effect.Effect<number | undefined, HoldingsDbError>

// Each side's listed shares: the report date's for its own counts, the
// trading day before's for the previous day's. A stock's listed shares can
// change on the report date, and each side's % is of its own day's.
//
// Decision: a single-account ambiguous count is resolved against listed shares
// (apps/dashboard/docs/adr/0130-a-single-account-ambiguous-count-is-resolved-against-listed-shares.md)
interface ListedShares {
  readonly current: ListedOn
  readonly previous: ListedOn
}

// One side's readings that sum, narrowed to those whose % of the stock's
// listed shares is the printed one.
// Decision: a single-account ambiguous count is resolved against listed shares
// (apps/dashboard/docs/adr/0130-a-single-account-ambiguous-count-is-resolved-against-listed-shares.md)
const byListedShares = Effect.fnUntraced(function* (
  block: Block,
  side: Side,
  found: ReadonlyArray<Fit>,
  percentage: number,
  listedShares: ListedShares
) {
  const listed = yield* (
    side === CURRENT ? listedShares.current : listedShares.previous
  )(block.stock)
  if (listed === undefined)
    return yield* failAt(
      block.at,
      side.combined,
      "is ambiguous, and no parsed investor-type report on or before the day lists the stock's listed shares"
    )
  const matching: Array<Fit> = []
  for (const each of found)
    if ((yield* hundredthsOf(each.combined, listed)) === percentage)
      matching.push(each)
  if (matching.length !== 1)
    return yield* failAt(
      block.at,
      side.combined,
      `is ambiguous, and ${matching.length === 0 ? "neither" : "each"} reading gives its % of the ${listed.toLocaleString("en-US")} listed shares`
    )
  return matching
})

// One side's shares, resolved: the combined count and each account's.
const resolveSide = Effect.fnUntraced(function* (
  block: Block,
  side: Side,
  combined: ReadonlyArray<number>,
  percentage: number,
  listedShares: ListedShares
) {
  const accounts = block.accounts.map(
    (account) => (side === CURRENT ? account.current : account.previous) ?? [0]
  )
  const sums = yield* fits(block, combined, accounts, side.combined)
  const found =
    sums.length > 1 && block.accounts.length === 1
      ? yield* byListedShares(block, side, sums, percentage, listedShares)
      : sums
  const [only] = found
  if (only === undefined || found.length > 1)
    return yield* failAt(
      block.at,
      side.combined,
      found.length === 0
        ? "is no sum of its accounts' shares in any reading"
        : "is the sum of its accounts' shares in more than one reading"
    )
  return only
})

// The above_5_holder and above_5_account columns a parse writes, in the
// order a gathered row holds them.
const HOLDER_COLUMNS = [
  "stock_code",
  "no",
  "issuer_name",
  "holder_name",
  "holder_key",
  "scripless",
  "percentage_hundredths",
] as const
const ACCOUNT_COLUMNS = [
  "stock_code",
  "no",
  "ordinal",
  "custodian",
  "account_name",
  "origin",
  "nationality",
  "domicile",
  "scripless",
] as const

type HolderRow = Record<(typeof HOLDER_COLUMNS)[number], SqlValue>
type AccountRecord = Record<(typeof ACCOUNT_COLUMNS)[number], SqlValue>

// The previous day's side of a block, resolved; undefined when the investor
// isn't listed that day.
const previousSide = Effect.fnUntraced(function* (
  block: Block,
  listedShares: ListedShares
) {
  const { combined, percentage } = block.previous
  if (combined === undefined && percentage === undefined) return undefined
  if (combined === undefined || percentage === undefined)
    return yield* failAt(
      block.at,
      combined === undefined ? PREVIOUS.combined : PREVIOUS.percentage,
      "is `-` while its previous-day share or % isn't"
    )
  return yield* resolveSide(block, PREVIOUS, combined, percentage, listedShares)
})

// One account's row, its Perubahan checked against its resolved shares.
const accountRecord = Effect.fnUntraced(function* (
  block: Block,
  index: number,
  current: Fit,
  previous: Fit | undefined
) {
  const account = block.accounts[index]
  if (account === undefined)
    return yield* unreadable(`${block.name} has no account ${index + 1}`)
  if (previous === undefined && account.previous !== undefined)
    return yield* failAt(
      account.at,
      PREVIOUS.shares,
      "is listed while its investor isn't on the previous day"
    )
  const now = current.shares[index] ?? 0
  const change = now - (previous?.shares[index] ?? 0)
  const unlisted =
    account.previous === undefined || account.current === undefined
  if (unlisted && account.change !== undefined)
    return yield* failAt(
      account.at,
      CHANGE,
      "isn't `-` beside a `-` share count"
    )
  if (!unlisted && !(account.change ?? []).includes(change))
    return yield* failAt(
      account.at,
      CHANGE,
      `isn't ${change.toLocaleString("en-US")}, the report date's shares minus the previous day's`
    )
  return {
    stock_code: block.stock,
    no: block.no,
    ordinal: index + 1,
    custodian: account.custodian,
    account_name: account.accountName,
    origin: account.origin,
    nationality: account.nationality,
    domicile: account.domicile,
    scripless: now,
  } satisfies AccountRecord
})

// One block, checked and resolved: its holder row and its account rows.
// Decision: repeat blocks are stored as published, and collapsed on read
// (apps/dashboard/docs/adr/0131-above-5-repeat-blocks-are-stored-as-published.md)
const blockRows = Effect.fnUntraced(function* (
  block: Block,
  listedShares: ListedShares
) {
  const current = yield* resolveSide(
    block,
    CURRENT,
    block.current.combined,
    block.current.percentage,
    listedShares
  )
  const previous = yield* previousSide(block, listedShares)
  const accounts: Array<AccountRecord> = []
  for (let index = 0; index < block.accounts.length; index++)
    accounts.push(yield* accountRecord(block, index, current, previous))
  return {
    holder: {
      stock_code: block.stock,
      no: block.no,
      issuer_name: block.issuer,
      holder_name: block.holder,
      holder_key: yield* holderKey(block.holder),
      scripless: current.combined,
      percentage_hundredths: block.current.percentage,
    } satisfies HolderRow,
    accounts,
  }
})

// The stock a data row's B names: text, or TRUE's code as a boolean cell.
// Decision: a row with any value must name its stock by a text code
// (apps/dashboard/docs/adr/0047-a-holdings-row-with-values-must-name-its-stock.md)
const rowStock = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow
) {
  const code = cells.get(CODE)
  if (typeof code !== "string")
    return yield* unreadable(
      `Row ${rowNumber}'s Kode Efek (B) isn't text: ${yield* excerpt(yield* cellText(code))}`
    )
  const stock = code.trim()
  if (stock === "" || stock.length > STOCK_CODE_MAX_LENGTH)
    return yield* unreadable(
      `Row ${rowNumber}'s Kode Efek (B) isn't a stock code: ${yield* excerpt(stock)}`
    )
  return stock
})

// The first row of a block: its `No` and the investor's columns.
const blockStart = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow,
  stock: string,
  expectedNo: number
) {
  const no = cells.get(NO)
  if (no !== expectedNo)
    return yield* unreadable(
      `${stock} (row ${rowNumber})'s No (A) isn't ${expectedNo}: ${yield* excerpt(yield* cellText(no))}`
    )
  const first: At = { cells, where: `${stock} (row ${rowNumber})` }
  const holder = yield* requiredTextAt(first, HOLDER, MAX_NAME_LENGTH)
  const name = `${stock} ${yield* excerpt(holder)}`
  const at: At = { cells, where: `${name} (row ${rowNumber})` }
  const current = yield* readingsAt(at, CURRENT.combined, false)
  const percentage = yield* percentageAt(at, CURRENT.percentage)
  if (current === undefined || percentage === undefined)
    return yield* failAt(
      at,
      current === undefined ? CURRENT.combined : CURRENT.percentage,
      "is `-` on the report date"
    )
  return {
    at,
    name,
    stock,
    no: expectedNo,
    issuer: yield* requiredTextAt(at, ISSUER, MAX_NAME_LENGTH),
    holder,
    previous: {
      combined: yield* readingsAt(at, PREVIOUS.combined, false),
      percentage: yield* percentageAt(at, PREVIOUS.percentage),
    },
    current: { combined: current, percentage },
    accounts: new Array<SecuritiesAccountRow>(),
  } satisfies Block
})

// The listed shares each stock had on `date`, read when a block needs them
// and kept for the rest of the day.
const listedSharesOn = Effect.fnUntraced(function* (date: string) {
  const db = yield* HoldingsDb
  const known = new Map<string, number | undefined>()
  return Effect.fnUntraced(function* (stock: string) {
    if (known.has(stock)) return known.get(stock)
    const [rows = []] = yield* db.batch([
      {
        sql:
          "SELECT shares_outstanding FROM investor_type_stock_month " +
          "WHERE stock_code = ? AND data_date <= ? ORDER BY data_date DESC LIMIT 1",
        params: [stock, date],
      },
    ])
    const [row] = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ shares_outstanding: Schema.Number }))
    )(rows)
    known.set(stock, row?.shares_outstanding)
    return row?.shares_outstanding
  })
})

// Where the sheet's reader is: the title, the two header rows, the data, then
// the legend's rows.
type Place =
  | { readonly at: "title" | "header" | "subheader" | "data" }
  | { readonly at: "legend"; readonly next: number }

// One day's rows, read a row at a time and checked against `date`.
const parseSheet = Effect.fnUntraced(function* (
  date: string,
  bytes: Uint8Array
) {
  const previousDay = yield* tradingDayBefore(date)
  const listedShares: ListedShares = {
    current: yield* listedSharesOn(date),
    previous: yield* listedSharesOn(previousDay),
  }
  const title = `${TITLE} ${yield* titleDate(date)}`
  const header = [
    "No",
    "Kode Efek",
    "Nama Emiten",
    "Nama Pemegang Rekening Efek",
    "Nama Pemegang Saham",
    "Nama Rekening Efek",
    "Alamat",
    "Alamat (Lanjutan)",
    "Kebangsaan",
    "Domisili",
    "Status (Lokal/Asing)",
    `Kepemilikan Per ${yield* headerDate(previousDay)}`,
    "",
    "",
    `Kepemilikan Per ${yield* headerDate(date)}`,
    "",
    "",
    "Perubahan",
  ]
  const subheader = [
    ...Array.from({ length: PREVIOUS.shares }, () => ""),
    SHARES_LABEL,
    COMBINED_LABEL,
    PERCENTAGE_LABEL,
    SHARES_LABEL,
    COMBINED_LABEL,
    PERCENTAGE_LABEL,
  ]
  // Widened, or TypeScript keeps the start it sees for after the rows.
  let place = { at: "title" } as Place
  let block: Block | undefined
  let rowCount = 0
  const stocks = new Set<string>()
  const holders = yield* monthRows("above_5_holder", HOLDER_COLUMNS)
  const accounts = yield* monthRows("above_5_account", ACCOUNT_COLUMNS)
  const close = Effect.fnUntraced(function* () {
    if (block === undefined) return
    const rows = yield* blockRows(block, listedShares)
    yield* holders.add(HOLDER_COLUMNS.map((column) => rows.holder[column]))
    for (const account of rows.accounts)
      yield* accounts.add(ACCOUNT_COLUMNS.map((column) => account[column]))
  })
  // The title row, checked against the day.
  const onTitle = Effect.fnUntraced(function* (
    rowNumber: number,
    cells: ReadRow
  ) {
    const dated = yield* cellText(cells.get(NO))
    if (cells.size === 1 && dated.startsWith(`${TITLE} `) && dated !== title)
      return yield* unreadable(
        `The title is dated ${yield* excerpt(dated.slice(TITLE.length + 1))}, not ${yield* titleDate(date)}`
      )
    yield* checkLone(rowNumber, cells, title, `the title, ${title}`)
  })
  // The legend's next row.
  const onLegend = Effect.fnUntraced(function* (
    rowNumber: number,
    cells: ReadRow,
    next: number
  ) {
    const text = LEGEND[next]
    if (text === undefined)
      return yield* unreadable(`Row ${rowNumber} follows the legend`)
    yield* checkLone(rowNumber, cells, text, `the legend's ${text}`)
  })
  // A block's first row: the block before it ends.
  const onBlockStart = Effect.fnUntraced(function* (
    rowNumber: number,
    cells: ReadRow,
    stock: string
  ) {
    yield* close()
    if (!stocks.has(stock)) {
      if (stocks.size === MAX_STOCKS) return yield* unreadable(TOO_MANY_STOCKS)
      stocks.add(stock)
    }
    const started = yield* blockStart(
      rowNumber,
      cells,
      stock,
      (block?.no ?? 0) + 1
    )
    started.accounts.push(yield* accountRow(started.at))
    block = started
  })
  // A block's later row: one more account.
  const onAccount = Effect.fnUntraced(function* (
    rowNumber: number,
    cells: ReadRow,
    stock: string
  ) {
    if (block === undefined)
      return yield* unreadable(
        `${stock} (row ${rowNumber}) has no No (A) and follows no block`
      )
    if (stock !== block.stock)
      return yield* unreadable(
        `${stock} (row ${rowNumber}) has no No (A), so it is ${block.stock}'s account, not ${stock}'s`
      )
    const at: At = { cells, where: `${block.name} (row ${rowNumber})` }
    for (const column of INVESTOR_COLUMNS)
      if (cells.has(column))
        return yield* failAt(at, column, "isn't empty on an account row")
    block.accounts.push(yield* accountRow(at))
  })
  // A row with B: a block's first row or one of its accounts.
  const onData = Effect.fnUntraced(function* (
    rowNumber: number,
    cells: ReadRow
  ) {
    const last = Math.max(...cells.keys())
    if (last > CHANGE)
      return yield* unreadable(
        `Row ${rowNumber} holds a cell past R, in ${yield* columnLetters(last)}`
      )
    if (rowCount === MAX_ROWS)
      return yield* unreadable(
        `The report lists more than ${MAX_ROWS.toLocaleString("en-US")} rows`
      )
    rowCount++
    const stock = yield* rowStock(rowNumber, cells)
    if (cells.has(NO)) yield* onBlockStart(rowNumber, cells, stock)
    else yield* onAccount(rowNumber, cells, stock)
  })
  yield* forEachRow(bytes, (rowNumber, cells) =>
    Effect.gen(function* () {
      switch (place.at) {
        case "title":
          yield* onTitle(rowNumber, cells)
          place = { at: "header" }
          return
        case "header":
          yield* checkLabels(rowNumber, cells, header)
          place = { at: "subheader" }
          return
        case "subheader":
          yield* checkLabels(rowNumber, cells, subheader)
          place = { at: "data" }
          return
        case "data":
          if (cells.has(CODE)) return yield* onData(rowNumber, cells)
          yield* close()
          block = undefined
          yield* onLegend(rowNumber, cells, 0)
          place = { at: "legend", next: 1 }
          return
        case "legend":
          yield* onLegend(rowNumber, cells, place.next)
          place = { at: "legend", next: place.next + 1 }
      }
    })
  )
  if (place.at !== "legend")
    return yield* unreadable(
      place.at === "data"
        ? "The report ends without its legend"
        : "The report ends before its header"
    )
  const missing = LEGEND[place.next]
  if (missing !== undefined)
    return yield* unreadable(`The report's legend has no ${missing}`)
  if (stocks.size === 0) return yield* unreadable("The report has no holders")
  return {
    stockCount: stocks.size,
    tables: [yield* holders.gathered, yield* accounts.gathered],
  }
})

// Parses one archived report and replaces its data date's above-5% holders
// with it, recording the version it came from. The number of stocks parsed.
export const parseAbove5Day = Effect.fnUntraced(function* (
  dataDate: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { stockCount, tables } = yield* parseSheet(dataDate, bytes)
  yield* replaceMonth({
    dateColumn: "data_date",
    date: dataDate,
    tables,
    record: {
      table: "above_5_day",
      values: {
        sha256,
        parser_version: ABOVE_5_PARSER_VERSION,
        parsed_at: parsedAt,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stockCount
})

// Its parsed tables. `stock` counts a day's holder rows, not its stocks.
export const ABOVE_5_TABLES: MonthTables = {
  month: "above_5_day",
  stock: "above_5_holder",
  dateColumn: "data_date",
}
