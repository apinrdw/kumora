// KSEI's monthly Kepemilikan Efek file (BalanceposEfek<YYYYMMDD>.zip),
// parsed into parsed holdings (holdings-migrations/0002_ksei.sql). Spec
// apinrdw/kumora#363, "Reading KSEI's BalanceposEfek".
import { Effect, Schema } from "effect"

import type { KseiType, SplitOrigin } from "@/domain/holdings"

import type { SqlValue } from "./db.ts"
import { replaceMonth } from "./month-replace.ts"
import { parsedMonths } from "./months-to-parse.ts"
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
  return yield* unreadable(`${where} isn't a share count: ${String(field)}`)
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

// One month's EQUITY rows: a stock-month per stock, and its holdings.
const parseRows = Effect.fnUntraced(function* (text: string) {
  const [header, ...lines] = text.split(/\r?\n/)
  if (header !== HEADER)
    return yield* unreadable(`The header isn't the known one: ${header}`)
  const stocks: Array<[string, number, number, number]> = []
  const holdings: Array<Holding> = []
  const seen = new Set<string>()
  for (const [index, line] of lines.entries()) {
    if (line === "") continue
    const fields = line.split("|")
    const where = `Line ${index + 2}`
    if (fields.length !== COLUMNS)
      return yield* unreadable(`${where} has ${fields.length} fields`)
    const [, code = "", type] = fields
    if (type !== "EQUITY") continue
    const stock = code.trim()
    const of = `${stock} (line ${index + 2})`
    if (seen.has(stock)) return yield* unreadable(`${of} is listed twice`)
    seen.add(stock)
    const local = yield* originHoldings(stock, fields, "local", of)
    const foreign = yield* originHoldings(stock, fields, "foreign", of)
    stocks.push([
      stock,
      yield* shareCount(fields[3], `${of}'s Sec. Num`),
      yield* shareCount(fields[4], `${of}'s Price`),
      local.total + foreign.total,
    ])
    holdings.push(...local.holdings, ...foreign.holdings)
  }
  if (stocks.length === 0)
    return yield* unreadable("The file has no EQUITY rows")
  return { stocks, holdings }
})

// Parses one archived file and replaces its period end's parsed holdings
// with it, recording the version it came from. The number of stocks parsed.
export const parseKseiMonth = Effect.fnUntraced(function* (
  periodEnd: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { stocks, holdings } = yield* parseRows(
    yield* fileText(bytes).pipe(
      Effect.catchTag("ZipUnreadable", ({ message }) =>
        Effect.fail(unreadable(message))
      )
    )
  )
  yield* replaceMonth({
    dateColumn: "period_end",
    date: periodEnd,
    tables: [
      {
        table: "ksei_holding",
        columns: ["stock_code", "origin", "investor_type", "shares"],
        rows: holdings,
      },
      {
        table: "ksei_stock_month",
        columns: ["stock_code", "listed_shares", "price", "total_scripless"],
        rows: stocks,
      },
    ],
    record: {
      table: "ksei_month",
      values: {
        sha256,
        parser_version: KSEI_PARSER_VERSION,
        parsed_at: parsedAt,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stocks.length
})

// The version each parsed period end came from.
export const parsedKseiMonths = parsedMonths("ksei_month", "period_end")
