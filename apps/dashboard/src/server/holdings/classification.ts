// IDX's month-end "holdings by investor classification" report, parsed into
// parsed holdings (holdings-migrations/0001_classification.sql). Spec
// apinrdw/kumora#363, "Reading the IDX classification xlsx".
import { Effect, Schema } from "effect"

import { CLASSIFICATIONS, Classification, type Origin } from "@/domain/holdings"

import type { SqlValue } from "./db.ts"
import {
  MAX_STOCKS,
  monthRows,
  replaceMonth,
  TOO_MANY_STOCKS,
} from "./month-replace.ts"
import { parsedMonths } from "./months-to-parse.ts"
import { type Cell, forEachRow, type Row } from "./xlsx.ts"

// Bumped whenever parsing changes what it stores: the archive run's
// reconcile then parses every month again.
export const PARSER_VERSION = 2

const BY_LABEL = new Map<string, Classification>(
  Classification.literals.map((slug) => [CLASSIFICATIONS[slug].header, slug])
)

class ClassificationUnreadable extends Schema.TaggedError<ClassificationUnreadable>()(
  "ClassificationUnreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) =>
  new ClassificationUnreadable({ message })

// A header cell's label and origin: `Local_Bank` is ("bank", local), `BANK`
// ("bank", combined), `SHARE_CODE` ("share code", combined).
const headerLabel = (cell: Cell) =>
  Effect.sync(() => {
    const text = typeof cell === "string" ? cell.trim().toLowerCase() : ""
    const split = /^(local|foreign)_(.*)$/.exec(text)
    const label = (split?.[2] ?? text.replaceAll("_", " "))
      .replaceAll(/\s+/g, " ")
      .trim()
    return { label, origin: (split?.[1] ?? "combined") as Origin }
  })

interface Layout {
  readonly headerRow: number
  readonly code: number
  readonly issuer: number
  readonly total: number
  // Each classification as `local` and `foreign` (Sep+), not `combined`.
  readonly split: boolean
  readonly classifications: ReadonlyArray<{
    readonly column: number
    readonly classification: Classification
    readonly origin: Origin
  }>
}

// Every classification column of a header row: each labelled column but
// `known` (DATE, SHARE CODE, ISSUER NAME, TOTAL SCRIPLESS). A layout names
// each of the 39 once, all `combined` (Mar–Aug) or each as `local` and as
// `foreign` (Sep+).
const classificationColumns = Effect.fnUntraced(function* (
  headerRow: number,
  cells: Row,
  known: ReadonlySet<number>
) {
  const columns: Array<Layout["classifications"][number]> = []
  const seen = new Set<string>()
  for (const [column, cell] of cells) {
    const { label, origin } = yield* headerLabel(cell)
    if (label === "" || known.has(column)) continue
    const classification = BY_LABEL.get(label)
    if (classification === undefined)
      return yield* unreadable(
        `Header row ${headerRow} names an unknown classification: ${String(cell).trim()}`
      )
    if (seen.has(`${origin}:${classification}`))
      return yield* unreadable(
        `Header row ${headerRow} names ${String(cell).trim()} twice`
      )
    seen.add(`${origin}:${classification}`)
    columns.push({ column, classification, origin })
  }
  const count = Object.keys(CLASSIFICATIONS).length
  const ofOrigin = (origin: Origin) =>
    columns.filter((column) => column.origin === origin).length
  const combined = ofOrigin("combined") === count && columns.length === count
  const split =
    ofOrigin("local") === count &&
    ofOrigin("foreign") === count &&
    columns.length === 2 * count
  if (!combined && !split)
    return yield* unreadable(
      `Header row ${headerRow} matches neither layout: it names ${columns.length} classification columns, not the ${count} classifications once each, or once each as Local_ and as Foreign_`
    )
  return { split, classifications: columns }
})

// The header row is found by its labels: row 6 in the Mar–Aug 2026 layout
// (`DATE`, `SHARE CODE`, `ISSUER NAME`, 39 classifications, `TOTAL
// SCRIPLESS`), row 4 from Sep 2026 (`DATE`, `SHARE_CODE`, `ISSUER_NAME`,
// `Local_<class>` × 39, `Foreign_<class>` × 39, `Total Scripless`). Cells
// past the labelled columns, such as May 2026's empty trailing one, are
// never read. A row naming no SHARE CODE is not the header row: undefined.
const headerLayout = Effect.fnUntraced(function* (
  headerRow: number,
  cells: Row
) {
  // Each label's first column.
  const labels = new Map<string, number>()
  for (const [column, cell] of cells) {
    const { label } = yield* headerLabel(cell)
    if (!labels.has(label)) labels.set(label, column)
  }
  const code = labels.get("share code")
  if (code === undefined) return undefined
  const issuer = labels.get("issuer name")
  if (issuer === undefined)
    return yield* unreadable(`Header row ${headerRow} has no ISSUER NAME`)
  const total = labels.get("total scripless")
  if (total === undefined)
    return yield* unreadable(`Header row ${headerRow} has no TOTAL SCRIPLESS`)
  const known = new Set([labels.get("date") ?? -1, code, issuer, total])
  return {
    headerRow,
    code,
    issuer,
    total,
    ...(yield* classificationColumns(headerRow, cells, known)),
  } satisfies Layout
})

const shareCount = Effect.fnUntraced(function* (
  cell: Cell | undefined,
  where: string
) {
  if (cell === null || cell === undefined) return 0
  if (typeof cell === "number" && Number.isSafeInteger(cell) && cell >= 0)
    return cell
  return yield* unreadable(`${where} isn't a share count: ${String(cell)}`)
})

type Holding = [string, Classification, Origin, number]

const formatShares = (count: number) =>
  Effect.sync(() => count.toLocaleString("en-US"))

// One stock row's non-zero holdings, and in a split month each
// classification's `combined` sum of local and foreign. Its classifications
// must sum to its total.
const rowHoldings = Effect.fnUntraced(function* (
  stock: string,
  cells: Row,
  layout: Layout,
  total: number,
  where: string
) {
  const holdings: Array<Holding> = []
  const combined = new Map<Classification, number>()
  let sum = 0
  for (const { column, classification, origin } of layout.classifications) {
    const shares = yield* shareCount(cells.get(column), where)
    sum += shares
    if (shares === 0) continue
    holdings.push([stock, classification, origin, shares])
    if (origin !== "combined")
      combined.set(classification, (combined.get(classification) ?? 0) + shares)
  }
  if (sum !== total)
    return yield* unreadable(
      `${where}'s classifications sum to ${yield* formatShares(sum)}, not its TOTAL SCRIPLESS of ${yield* formatShares(total)}`
    )
  for (const [classification, shares] of combined)
    holdings.push([stock, classification, "combined", shares])
  return holdings
})

// One month's rows, read a row at a time: the header row's layout, then a
// stock-month per stock below it, and its holdings.
const parseSheet = Effect.fnUntraced(function* (bytes: Uint8Array) {
  let layout: Layout | undefined
  let stockCount = 0
  const stocks = yield* monthRows("classification_stock_month", [
    "stock_code",
    "issuer_name",
    "total_scripless",
  ])
  const holdings = yield* monthRows("classification_holding", [
    "stock_code",
    "classification",
    "origin",
    "shares",
  ])
  yield* forEachRow(bytes, (rowNumber, cells) =>
    Effect.gen(function* () {
      if (layout === undefined) {
        layout = yield* headerLayout(rowNumber, cells)
        return
      }
      const code = cells.get(layout.code)
      if (rowNumber <= layout.headerRow || typeof code !== "string") return
      const stock = code.trim()
      if (stock === "") return
      if (stockCount === MAX_STOCKS) return yield* unreadable(TOO_MANY_STOCKS)
      stockCount++
      const where = `${stock} (row ${rowNumber})`
      const total = yield* shareCount(
        cells.get(layout.total),
        `${where}'s total`
      )
      yield* stocks.add([
        stock,
        String(cells.get(layout.issuer) ?? "").trim(),
        total,
      ])
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
    return yield* unreadable("No header row names SHARE CODE")
  if (stockCount === 0) return yield* unreadable("The report has no stocks")
  return {
    split: layout.split,
    stockCount,
    tables: [yield* holdings.gathered, yield* stocks.gathered],
  }
})

// Parses one archived report and replaces its data date's parsed holdings
// with it, recording the version it came from. The number of stocks parsed.
export const parseClassificationMonth = Effect.fnUntraced(function* (
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
      table: "classification_month",
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
export const parsedClassificationMonths = parsedMonths(
  "classification_month",
  "data_date"
)
