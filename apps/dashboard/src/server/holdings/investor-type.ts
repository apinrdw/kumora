// IDX's month-end "holdings by investor type" report, parsed into
// investor-type holdings (holdings-migrations/0005_investor_type.sql). Spec
// apinrdw/kumora#402, "Investor-type parser"; the report's facts are in
// apinrdw/kumora#395.
import { STOCK_CODE_MAX_LENGTH } from "@workspace/relay"
import { Effect, Schema } from "effect"

import type { KseiType, Origin } from "@/domain/holdings"

import type { SqlValue } from "../d1.ts"
import { excerpt } from "./excerpt.ts"
import {
  MAX_STOCKS,
  monthRows,
  replaceMonth,
  TOO_MANY_STOCKS,
} from "./month-replace.ts"
import { parsedMonths } from "./months-to-parse.ts"
import { type Cell, forEachRow, type Row } from "./xlsx.ts"

// Bumped whenever parsing changes what it stores: the investor-type parse
// run then parses every month again.
export const PARSER_VERSION = 1

class InvestorTypeUnreadable extends Schema.TaggedError<InvestorTypeUnreadable>()(
  "InvestorTypeUnreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) => new InvestorTypeUnreadable({ message })

// The 9 types as the report labels them, in its column order.
const TYPE_LABELS: ReadonlyArray<readonly [KseiType, string]> = [
  ["CP", "CP: Corporate (perusahaan terbatas)"],
  ["FD", "FD: Foundation (yayasan)"],
  ["IB", "IB: Financial Institution (institusi keuangan)"],
  ["ID", "ID: Individual"],
  ["IS", "IS: Insurance (asuransi)"],
  ["MF", "MF: Mutual Fund (reksa dana)"],
  ["OT", "OT: Others"],
  ["PF", "PF: Pension Fund (pengelola dana pensiun)"],
  ["SC", "SC: Securities Company (perusahaan sekuritas)"],
]

const DATE = 0
const CODE = 1
const SHARES = 2
// Each layout's first type column, D.
const FIRST_TYPE = 3

// One type's <5% and >=5% columns, of one origin.
interface TypeColumns {
  readonly type: KseiType
  readonly origin: Origin
  readonly under5: number
  readonly atLeast5: number
}

interface Layout {
  readonly split: boolean
  // Each header row's labelled cells by column, from the row naming
  // STOCK_CODE down.
  readonly header: ReadonlyArray<ReadonlyMap<number, string>>
  readonly sharesLabel: string
  readonly total: number
  readonly totalLabel: string
  readonly types: ReadonlyArray<TypeColumns>
}

// The type label row and the <5% / >=5% label row of `origins`' type
// columns, from D.
const typeColumns = (origins: ReadonlyArray<Origin>) =>
  Effect.sync(() => {
    const labels = new Map<number, string>()
    const sizeLabels = new Map<number, string>()
    const types: Array<TypeColumns> = []
    let column = FIRST_TYPE
    for (const origin of origins)
      for (const [type, label] of TYPE_LABELS) {
        labels.set(column, label)
        sizeLabels.set(column, "<5%")
        sizeLabels.set(column + 1, ">=5%")
        types.push({ type, origin, under5: column, atLeast5: column + 1 })
        column += 2
      }
    return { labels, sizeLabels, types, total: column }
  })

const layoutOf = Effect.fnUntraced(function* (
  sharesLabel: string,
  totalLabel: string,
  origins: ReadonlyArray<Origin>
) {
  const { labels, sizeLabels, types, total } = yield* typeColumns(origins)
  const first = new Map<number, string>([
    [DATE, "DATE"],
    [CODE, "STOCK_CODE"],
    [SHARES, sharesLabel],
    [total, totalLabel],
  ])
  const split = origins.length > 1
  if (split) {
    // DOMESTIC and FOREIGN each over their 18 columns.
    first.set(FIRST_TYPE, "DOMESTIC")
    first.set(FIRST_TYPE + 2 * TYPE_LABELS.length, "FOREIGN")
  }
  return {
    split,
    header: split
      ? [first, labels, sizeLabels]
      : [new Map([...first, ...labels]), sizeLabels],
    sharesLabel,
    total,
    totalLabel,
    types,
  } satisfies Layout
})

// The two layouts, by their shares outstanding column's label (C):
// Nov–Dec 2025 have 2 header rows, `DATE`, `STOCK_CODE`,
// `JUMLAH_SAHAM_BEREDAR`, 9 types × (`<5%`, `>=5%`) and
// `TOTAL_SAHAM_SCRIPLESS`; Jan 2026 on have 3, the shares column
// `NUMBER_OF_SHARES`, `DOMESTIC` then `FOREIGN` types and `TOTAL SCRIPLESS`.
// Decision: a header must match a layout's every label exactly, or the month
// fails: within each layout IDX wrote the same header in all 12 months, so
// any other label is a layout change, not a variant to tolerate. See
// apinrdw/kumora#397.
const LAYOUTS: ReadonlyMap<string, Layout> = new Map([
  [
    "JUMLAH_SAHAM_BEREDAR",
    Effect.runSync(
      layoutOf("JUMLAH_SAHAM_BEREDAR", "TOTAL_SAHAM_SCRIPLESS", ["combined"])
    ),
  ],
  [
    "NUMBER_OF_SHARES",
    Effect.runSync(
      layoutOf("NUMBER_OF_SHARES", "TOTAL SCRIPLESS", ["local", "foreign"])
    ),
  ],
])

// 3 → "D"
const columnLetters = (column: number) =>
  Effect.sync(() => {
    let letters = ""
    for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
      letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
    return letters
  })

const labelOf = (cell: Cell | undefined) =>
  Effect.sync(() => (typeof cell === "string" ? cell.trim() : cell))

// Checks one header row's cells up to the total column against the layout's
// `expected` labels: cells past it, such as Apr 2026's empty styled ones,
// are never read.
const checkHeaderRow = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: Row,
  layout: Layout,
  expected: ReadonlyMap<number, string>
) {
  const columns = new Set([...cells.keys(), ...expected.keys()])
  for (const column of [...columns].sort((a, b) => a - b)) {
    if (column > layout.total) continue
    const label = yield* labelOf(cells.get(column))
    const want = expected.get(column)
    if (label === want) continue
    const where = `Header row ${rowNumber}'s ${yield* columnLetters(column)}`
    return yield* unreadable(
      want === undefined
        ? `${where} isn't empty: ${yield* excerpt(String(label))}`
        : `${where} isn't ${want}: ${yield* excerpt(String(label ?? ""))}`
    )
  }
})

// The layout the header row names by its shares outstanding label; undefined
// for a row naming no STOCK_CODE, which is above the header.
const headerLayout = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: Row
) {
  if ((yield* labelOf(cells.get(CODE))) !== "STOCK_CODE") return undefined
  const shares = yield* labelOf(cells.get(SHARES))
  const layout = typeof shares === "string" ? LAYOUTS.get(shares) : undefined
  if (layout === undefined)
    return yield* unreadable(
      `Header row ${rowNumber}'s C is neither ${[...LAYOUTS.keys()].join(" nor ")}: ${yield* excerpt(String(shares ?? ""))}`
    )
  const [first] = layout.header
  if (first !== undefined)
    yield* checkHeaderRow(rowNumber, cells, layout, first)
  return layout
})

const formatShares = (count: number) =>
  Effect.sync(() => count.toLocaleString("en-US"))

// A blank cell holds no shares.
const shareCount = Effect.fnUntraced(function* (
  cell: Cell | undefined,
  where: string
) {
  if (cell === undefined) return 0
  if (typeof cell === "number" && Number.isSafeInteger(cell) && cell >= 0)
    return cell
  return yield* unreadable(
    `${where} isn't a share count: ${yield* excerpt(String(cell))}`
  )
})

type Holding = [string, Origin, KseiType, number, number]

// One stock row's holdings, each type and origin with any shares, and in a
// split month each type's `combined` sum of local and foreign. Its type
// cells must sum to its total.
const rowHoldings = Effect.fnUntraced(function* (
  stock: string,
  cells: Row,
  layout: Layout,
  total: number,
  where: string
) {
  const holdings: Array<Holding> = []
  const combined = new Map<KseiType, [number, number]>()
  let sum = 0
  for (const { type, origin, under5, atLeast5 } of layout.types) {
    const under = yield* shareCount(cells.get(under5), where)
    const atLeast = yield* shareCount(cells.get(atLeast5), where)
    sum += under + atLeast
    if (under + atLeast === 0) continue
    holdings.push([stock, origin, type, under, atLeast])
    if (origin === "combined") continue
    const [heldUnder, heldAtLeast] = combined.get(type) ?? [0, 0]
    combined.set(type, [heldUnder + under, heldAtLeast + atLeast])
  }
  if (sum !== total)
    return yield* unreadable(
      `${where}'s types sum to ${yield* formatShares(sum)}, not its ${layout.totalLabel} of ${yield* formatShares(total)}`
    )
  for (const [type, [under, atLeast]] of combined)
    holdings.push([stock, "combined", type, under, atLeast])
  return holdings
})

// The stock a row below the header names; undefined for a row holding
// nothing a month stores, such as an empty trailing one or a DATE alone.
// Decision: a row holding a value under any labelled column but DATE must
// name its stock by a STOCK_CODE of text, as the classification parse
// requires: a row whose code wasn't read would be dropped from its month.
const rowStock = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: Row,
  layout: Layout
) {
  const code = cells.get(CODE)
  if (typeof code === "number")
    return yield* unreadable(
      `Row ${rowNumber}'s STOCK_CODE isn't text: ${yield* excerpt(String(code))}`
    )
  const stock = code?.trim() ?? ""
  if (stock === "") {
    const holds =
      code !== undefined ||
      [...cells.keys()].some(
        (column) => column > DATE && column <= layout.total
      )
    if (holds) return yield* unreadable(`Row ${rowNumber} has no STOCK_CODE`)
    return undefined
  }
  if (stock.length > STOCK_CODE_MAX_LENGTH)
    return yield* unreadable(
      `Row ${rowNumber}'s STOCK_CODE is over ${STOCK_CODE_MAX_LENGTH} characters: ${yield* excerpt(stock)}`
    )
  return stock
})

// One month's rows, read a row at a time: the header's layout, then a
// stock-month per stock below it, and its holdings.
const parseSheet = Effect.fnUntraced(function* (bytes: Uint8Array) {
  let layout: Layout | undefined
  // The header rows read so far.
  let headerRows = 0
  // The row each stock is listed in.
  const listed = new Map<string, number>()
  const stocks = yield* monthRows("investor_type_stock_month", [
    "stock_code",
    "shares_outstanding",
    "total_scripless",
  ])
  const holdings = yield* monthRows("investor_type_holding", [
    "stock_code",
    "origin",
    "investor_type",
    "under_5",
    "at_least_5",
  ])
  yield* forEachRow(bytes, (rowNumber, cells) =>
    Effect.gen(function* () {
      if (layout === undefined) {
        layout = yield* headerLayout(rowNumber, cells)
        if (layout !== undefined) headerRows = 1
        return
      }
      const expected = layout.header[headerRows]
      if (expected !== undefined) {
        yield* checkHeaderRow(rowNumber, cells, layout, expected)
        headerRows++
        return
      }
      const stock = yield* rowStock(rowNumber, cells, layout)
      if (stock === undefined) return
      const before = listed.get(stock)
      if (before !== undefined)
        return yield* unreadable(
          `Row ${rowNumber} lists ${stock} again, after row ${before}`
        )
      if (listed.size === MAX_STOCKS) return yield* unreadable(TOO_MANY_STOCKS)
      listed.set(stock, rowNumber)
      const where = `${stock} (row ${rowNumber})`
      const sharesOutstanding = yield* shareCount(
        cells.get(SHARES),
        `${where}'s ${layout.sharesLabel}`
      )
      const total = yield* shareCount(
        cells.get(layout.total),
        `${where}'s ${layout.totalLabel}`
      )
      yield* stocks.add([stock, sharesOutstanding, total])
      for (const holding of yield* rowHoldings(
        stock,
        cells,
        layout,
        total,
        where
      ))
        yield* holdings.add(holding)
    })
  )
  if (layout === undefined)
    return yield* unreadable("No header row names STOCK_CODE")
  if (listed.size === 0) return yield* unreadable("The report has no stocks")
  return {
    split: layout.split,
    stockCount: listed.size,
    tables: [yield* holdings.gathered, yield* stocks.gathered],
  }
})

// Parses one archived report and replaces its data date's investor-type
// holdings with it, recording the version it came from. The number of
// stocks parsed.
export const parseInvestorTypeMonth = Effect.fnUntraced(function* (
  dataDate: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { split, stockCount, tables } = yield* parseSheet(bytes)
  yield* replaceMonth({
    dateColumn: "data_date",
    date: dataDate,
    tables,
    record: {
      table: "investor_type_month",
      values: {
        sha256,
        parser_version: PARSER_VERSION,
        parsed_at: parsedAt,
        split: split ? 1 : 0,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stockCount
})

// The version each parsed month came from, by data date.
export const parsedInvestorTypeMonths = parsedMonths(
  "investor_type_month",
  "investor_type_stock_month",
  "data_date"
)
