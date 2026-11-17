// KSEI's monthly Securities holdings report (BalanceposEfek<YYYYMMDD>.zip),
// parsed into parsed holdings (holdings-migrations/0002_ksei.sql). Spec
// apinrdw/kumora#363, "Reading KSEI's BalanceposEfek".
import { STOCK_CODE_MAX_LENGTH } from "@workspace/relay"
import { Effect, Schema } from "effect"

import type { KseiType, SplitOrigin } from "@/domain/holdings"

import type { SqlValue } from "../d1.ts"
import { excerpt } from "./excerpt.ts"
import {
  MAX_STOCKS,
  monthRows,
  replaceMonth,
  TOO_MANY_STOCKS,
} from "./month-replace.ts"
import type { MonthTables } from "./months-to-parse.ts"
import { entryText, zipEntries } from "./zip.ts"

// Bumped whenever parsing changes what it stores: the KSEI parse run then
// parses every month again.
export const KSEI_PARSER_VERSION = 1

// The 9 KSEI investor types, in the order each origin's columns list them.
const TYPES = [
  "IS",
  "CP",
  "PF",
  "IB",
  "ID",
  "MF",
  "SC",
  "FD",
  "OT",
] as const satisfies ReadonlyArray<KseiType>

// Decision: the one header a file may have, byte for byte. Every file from
// Jan 2008 to Oct 2026 has it; a file with any other is rejected whole, so a
// changed layout never stores wrong numbers. The two `Total`s share a name
// and are read by position. See apinrdw/kumora#357.
const HEADER = [
  "Date",
  "Code",
  "Type",
  "Sec. Num",
  "Price",
  ...TYPES.map((type) => `Local ${type}`),
  "Total",
  ...TYPES.map((type) => `Foreign ${type}`),
  "Total",
].join("|")

const COLUMNS = HEADER.split("|").length
// Where each origin's 9 types start; its Total follows them.
const LOCAL = 5
const FOREIGN = LOCAL + TYPES.length + 1

class KseiUnreadable extends Schema.TaggedError<KseiUnreadable>()(
  "KseiUnreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) => new KseiUnreadable({ message })

// The one text file the zip holds, Balancepos<YYYYMMDD>.txt.
const fileText = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const entries = yield* zipEntries(bytes)
  const names = [...entries.keys()]
  const [name] = names
  if (names.length !== 1 || name === undefined)
    return yield* new KseiUnreadable({
      message: `The zip holds ${names.length} files, not one`,
    })
  return yield* entryText(bytes, entries, name)
})

const shareCount = Effect.fnUntraced(function* (
  field: string | undefined,
  where: string
) {
  const count = /^\d+$/.test(field ?? "") ? Number(field) : Number.NaN
  if (Number.isSafeInteger(count)) return count
  return yield* unreadable(
    `${where} isn't a share count: ${yield* excerpt(String(field))}`
  )
})

type Holding = [string, SplitOrigin, KseiType, number]

// One origin's non-zero holdings of a row, checked against its Total.
const originHoldings = Effect.fnUntraced(function* (
  stock: string,
  fields: ReadonlyArray<string>,
  origin: SplitOrigin,
  where: string
) {
  const start = origin === "local" ? LOCAL : FOREIGN
  const holdings: Array<Holding> = []
  let sum = 0
  for (const [index, type] of TYPES.entries()) {
    const shares = yield* shareCount(
      fields[start + index],
      `${where}'s ${origin} ${type}`
    )
    sum += shares
    if (shares > 0) holdings.push([stock, origin, type, shares])
  }
  const total = yield* shareCount(
    fields[start + TYPES.length],
    `${where}'s ${origin} Total`
  )
  if (sum !== total)
    return yield* unreadable(
      `${where}'s ${origin} types sum to ${sum}, not its ${origin} Total ${total}`
    )
  return { holdings, total }
})

// A line of `text`, without its `\n` or `\r\n`.
const LINE = /([^\n]*?)\r?(?:\n|$)/g

// A line's fields, split no further than one past the header's.
const lineFields = Effect.fnUntraced(function* (
  line: string,
  lineNumber: number
) {
  const fields = line.split("|", COLUMNS + 1)
  if (fields.length > COLUMNS)
    return yield* unreadable(
      `Line ${lineNumber} has more than ${COLUMNS} fields`
    )
  if (fields.length < COLUMNS)
    return yield* unreadable(`Line ${lineNumber} has ${fields.length} fields`)
  return fields
})

// The stock an EQUITY line names by its Code.
const lineStock = Effect.fnUntraced(function* (
  code: string,
  lineNumber: number
) {
  const stock = code.trim()
  if (stock === "") return yield* unreadable(`Line ${lineNumber} has no Code`)
  if (stock.length > STOCK_CODE_MAX_LENGTH)
    return yield* unreadable(
      `Line ${lineNumber}'s Code is over ${STOCK_CODE_MAX_LENGTH} characters: ${yield* excerpt(stock)}`
    )
  return stock
})

// One month's EQUITY rows: a stock-month per stock, and its holdings.
// Decision: lines are read one at a time, so what parsing keeps grows with
// the stocks read, never with the lines a file holds: splitting a file of
// 2.8 million short lines took 93 MiB at once.
const parseRows = Effect.fnUntraced(function* (text: string) {
  const lines = text.matchAll(LINE)
  const header = lines.next().value?.[1]
  if (header !== HEADER)
    return yield* unreadable(
      `The header isn't the known one: ${yield* excerpt(String(header))}`
    )
  const stocks = yield* monthRows("ksei_stock_month", [
    "stock_code",
    "listed_shares",
    "price",
    "total_scripless",
  ])
  const holdings = yield* monthRows("ksei_holding", [
    "stock_code",
    "origin",
    "investor_type",
    "shares",
  ])
  const seen = new Set<string>()
  let lineNumber = 1
  for (const [, line = ""] of lines) {
    lineNumber++
    if (line === "") continue
    const fields = yield* lineFields(line, lineNumber)
    const [, code = "", type] = fields
    if (type !== "EQUITY") continue
    const stock = yield* lineStock(code, lineNumber)
    const of = `${stock} (line ${lineNumber})`
    if (seen.has(stock)) return yield* unreadable(`${of} is listed twice`)
    if (seen.size === MAX_STOCKS) return yield* unreadable(TOO_MANY_STOCKS)
    seen.add(stock)
    const local = yield* originHoldings(stock, fields, "local", of)
    const foreign = yield* originHoldings(stock, fields, "foreign", of)
    yield* stocks.add([
      stock,
      yield* shareCount(fields[3], `${of}'s Sec. Num`),
      yield* shareCount(fields[4], `${of}'s Price`),
      local.total + foreign.total,
    ])
    for (const holding of [...local.holdings, ...foreign.holdings])
      yield* holdings.add(holding)
  }
  if (seen.size === 0) return yield* unreadable("The file has no EQUITY rows")
  return {
    stockCount: seen.size,
    tables: [yield* holdings.gathered, yield* stocks.gathered],
  }
})

// Parses one archived report and replaces its period end's parsed holdings
// with it, recording the version it came from. The number of stocks parsed.
export const parseKseiMonth = Effect.fnUntraced(function* (
  periodEnd: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { stockCount, tables } = yield* parseRows(
    yield* fileText(bytes).pipe(
      Effect.catchTag("ZipUnreadable", ({ message }) =>
        Effect.fail(unreadable(message))
      )
    )
  )
  yield* replaceMonth({
    dateColumn: "period_end",
    date: periodEnd,
    tables,
    record: {
      table: "ksei_month",
      values: {
        sha256,
        parser_version: KSEI_PARSER_VERSION,
        parsed_at: parsedAt,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stockCount
})

// Its parsed holdings tables.
export const KSEI_TABLES: MonthTables = {
  month: "ksei_month",
  stock: "ksei_stock_month",
  dateColumn: "period_end",
}
