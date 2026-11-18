// IDX's month-end "holders above 1%" report, parsed into ≥1% holders
// (holdings-migrations/0007_above_1.sql). Spec apinrdw/kumora#479,
// "Above-1% parser" and "Holder key"; the report's facts are in
// apinrdw/kumora#471.
import { STOCK_CODE_MAX_LENGTH } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  CLASSIFICATIONS,
  Classification,
  type Controller,
  KSEI_TYPES,
  type KseiType,
  type SplitOrigin,
} from "@/domain/holdings"

import type { SqlValue } from "../d1.ts"
import { excerpt } from "./excerpt.ts"
import { monthRows, replaceMonth } from "./month-replace.ts"
import type { MonthTables } from "./months-to-parse.ts"
import {
  CellError,
  columnLetters,
  forEachRow,
  type ReadCell,
  type ReadRow,
} from "./xlsx.ts"

// Bumped whenever parsing changes what it stores, the holder key included:
// the above-1% parse run then parses every month again.
export const ABOVE_1_PARSER_VERSION = 1

class Above1Unreadable extends Schema.TaggedError<Above1Unreadable>()(
  "Above1Unreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) => new Above1Unreadable({ message })

// Decision: at most 15,000 rows, 2× Feb 2026's 7,257; an INVESTOR_NAME of at
// most 256 characters, 2.5× the longest (102), and other text of 128, 2.7×
// ISSUER_NAME's (47). A parse holds every row and its holder key, so these
// keep it under PARSE_HEAP_MIB (tests/server/holdings/bounded-heap.ts):
// 20,000 rows of 256-character texts took past it.
const MAX_ROWS = 15_000
const MAX_NAME_LENGTH = 256
const MAX_TEXT_LENGTH = 128

// Words the holder key drops once punctuation is spaces: legal forms, then
// honorifics.
// Decision: `DR` is kept: it marks TLKM's depositary-receipt account at BNY
// Mellon, `THE BANK OF NEW YORK MELLON DR`, and dropping it merges that with
// BNY Mellon's own holding in the same month. Without it the list merges no
// two holders within any month of Feb–Oct 2026. See apinrdw/kumora#478.
const DROPPED_WORDS: ReadonlySet<string> = new Set([
  "PT",
  "TBK",
  "TB",
  "PERSERO",
  "IR",
  "DRS",
  "DRA",
  "H",
  "HJ",
  "HJH",
  "PROF",
  "SE",
  "SH",
  "ST",
  "MM",
  "MBA",
  "MSC",
  "SKOM",
  "SPD",
  "ME",
  "MSI",
  "SKED",
])

// The name a ≥1% holder is matched by, from one month to the next and
// across a month's rows: INVESTOR_NAME uppercased, each of .,;:'"()-/& a
// space, DROPPED_WORDS dropped, and the words sorted. `IR. T. PERMADI
// RACHMAT` and `T PERMADI RACHMAT` are both `PERMADI RACHMAT T`.
const holderKey = (name: string) =>
  Effect.sync(() =>
    name
      .toUpperCase()
      .replaceAll(/[.,;:'"()\-/&]/g, " ")
      .split(/\s+/)
      .filter((word) => word !== "" && !DROPPED_WORDS.has(word))
      .sort()
      .join(" ")
  )

// The column a layout reads each label from.
type Label =
  | "SHARE_CODE"
  | "ISSUER_NAME"
  | "INVESTOR_NAME"
  | "INVESTOR_TYPE"
  | "INVESTOR_CLASSIFICATION"
  | "CONTROLLER_OR_AFFILIATE"
  | "LOCAL_FOREIGN"
  | "NATIONALITY"
  | "DOMICILE"
  | "HOLDINGS_SCRIPLESS"
  | "HOLDINGS_SCRIP"
  | "TOTAL_HOLDING_SHARES"
  | "PERCENTAGE"

interface Layout {
  // The header row's labels, from A.
  readonly labels: ReadonlyArray<"DATE" | Label>
  // INVESTOR_TYPE (Feb–Mar 2026) or INVESTOR_CLASSIFICATION (Apr 2026 on).
  readonly investor: "INVESTOR_TYPE" | "INVESTOR_CLASSIFICATION"
  readonly controller: boolean
}

const layoutOf = (investor: Layout["investor"], controller: boolean) =>
  Effect.succeed<Layout>({
    labels: [
      "DATE",
      "SHARE_CODE",
      "ISSUER_NAME",
      "INVESTOR_NAME",
      investor,
      ...(controller ? (["CONTROLLER_OR_AFFILIATE"] as const) : []),
      "LOCAL_FOREIGN",
      "NATIONALITY",
      "DOMICILE",
      "HOLDINGS_SCRIPLESS",
      "HOLDINGS_SCRIP",
      "TOTAL_HOLDING_SHARES",
      "PERCENTAGE",
    ],
    investor,
    controller,
  })

// The header layouts, found by the header row's labels wherever it sits
// (row 5 in Feb, 7 in Mar–Apr, 6 in May–Sep and 5 in Oct 2026): Feb–Mar's
// INVESTOR_TYPE in E, Apr–Sep's INVESTOR_CLASSIFICATION in E, and Oct's
// CONTROLLER_OR_AFFILIATE in F with the rest one column right.
// Decision: a header must match a layout's every label exactly, or the month
// fails: across the 9 months IDX wrote these three, so any other label is a
// layout change, not a variant to tolerate. See apinrdw/kumora#473.
const LAYOUTS: ReadonlyArray<Layout> = Effect.runSync(
  Effect.all([
    layoutOf("INVESTOR_TYPE", false),
    layoutOf("INVESTOR_CLASSIFICATION", false),
    layoutOf("INVESTOR_CLASSIFICATION", true),
  ])
)

// A layout as a header row named it, with each label's column.
interface Found extends Layout {
  readonly column: ReadonlyMap<string, number>
}

const CODE = 1
const INVESTOR = 4

const labelOf = (cell: ReadCell | undefined) =>
  Effect.sync(() =>
    cell instanceof CellError
      ? cell.text
      : typeof cell === "string"
        ? cell.trim()
        : cell === undefined
          ? ""
          : String(cell)
  )

// The layout a header row names, checked label by label; undefined for a
// row naming no SHARE_CODE in B, which is above the header.
const headerLayout = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow
) {
  if ((yield* labelOf(cells.get(CODE))) !== "SHARE_CODE") return undefined
  const investor = yield* labelOf(cells.get(INVESTOR))
  const controller =
    (yield* labelOf(cells.get(INVESTOR + 1))) === "CONTROLLER_OR_AFFILIATE"
  const layout = LAYOUTS.find(
    (each) => each.investor === investor && each.controller === controller
  )
  if (layout === undefined)
    return yield* unreadable(
      `Header row ${rowNumber}'s E is neither INVESTOR_TYPE nor INVESTOR_CLASSIFICATION: ${yield* excerpt(investor)}`
    )
  const last = Math.max(layout.labels.length - 1, ...cells.keys())
  for (let column = 0; column <= last; column++) {
    const label = yield* labelOf(cells.get(column))
    const want: string = layout.labels[column] ?? ""
    if (label === want) continue
    const where = `Header row ${rowNumber}'s ${yield* columnLetters(column)}`
    return yield* unreadable(
      want === ""
        ? `${where} isn't empty: ${yield* excerpt(label)}`
        : `${where} isn't ${want}: ${yield* excerpt(label)}`
    )
  }
  return {
    ...layout,
    column: new Map(layout.labels.map((label, column) => [label, column])),
  } satisfies Found
})

// Each investor classification by its label once lowercased and stripped of
// spaces and of the classification report's `(xx)` code: `Mutual Funds`,
// `Sole proprietorship` and `PermanentEstablishment` all match.
const squeeze = (label: string) =>
  Effect.sync(() => label.toLowerCase().replaceAll(/\s+/g, ""))
const BY_CLASSIFICATION: ReadonlyMap<string, Classification> = new Map(
  Effect.runSync(
    Effect.forEach(Classification.literals, (slug) =>
      Effect.map(
        squeeze(CLASSIFICATIONS[slug].header.replace(/ \([a-z]{2}\)$/, "")),
        (label) => [label, slug] as const
      )
    )
  )
)

const KSEI_TYPE_CODES: ReadonlyMap<string, KseiType> = new Map(
  KSEI_TYPES.map((type) => [type, type])
)

const ORIGINS: ReadonlyMap<string, SplitOrigin> = new Map([
  ["L", "local"],
  ["F", "foreign"],
  // Feb 2026's Asing.
  ["A", "foreign"],
])

const CONTROLLERS: ReadonlyMap<string, Controller> = new Map([
  ["CONTROLLER", "controller"],
  ["AFFILIATE OF THE CONTROLLER", "affiliate"],
])

// What one row's cells give a reader: its stock and row number, for errors.
interface At {
  readonly cells: ReadRow
  readonly layout: Found
  readonly where: string
}

const cellAt = Effect.fnUntraced(function* (
  { cells, layout, where }: At,
  label: Label
) {
  const cell = cells.get(layout.column.get(label) ?? -1)
  if (cell instanceof CellError)
    return yield* unreadable(
      `${where}'s ${label} holds the error ${yield* excerpt(cell.text)}`
    )
  return cell
})

// A text cell, trimmed; null when blank.
const textAt = Effect.fnUntraced(function* (at: At, label: Label) {
  const cell = yield* cellAt(at, label)
  if (cell === undefined) return null
  if (typeof cell !== "string")
    return yield* unreadable(
      `${at.where}'s ${label} isn't text: ${yield* excerpt(String(cell))}`
    )
  const text = cell.trim()
  const max = label === "INVESTOR_NAME" ? MAX_NAME_LENGTH : MAX_TEXT_LENGTH
  if (text.length > max)
    return yield* unreadable(`${at.where}'s ${label} is over ${max} characters`)
  return text === "" ? null : text
})

// A share count; a missing cell, as Apr 2026's one HOLDINGS_SCRIP, holds 0.
const sharesAt = Effect.fnUntraced(function* (at: At, label: Label) {
  const cell = yield* cellAt(at, label)
  if (cell === undefined) return 0
  if (typeof cell === "number" && Number.isSafeInteger(cell) && cell >= 0)
    return cell
  return yield* unreadable(
    `${at.where}'s ${label} isn't a share count: ${yield* excerpt(String(cell))}`
  )
})

// PERCENTAGE as published, rounded to 2 decimals, × 100: 15.370000000000001
// and Apr 2026's 36.108405090747539 are 1537 and 3611.
// Decision: stored as published, never checked against the total or listed
// shares: 28 rows in Feb–Jul 2026 carry hand-typed percentages, and IDX's
// own value is what the report says. See apinrdw/kumora#473.
const hundredthsAt = Effect.fnUntraced(function* (at: At) {
  const cell = yield* cellAt(at, "PERCENTAGE")
  if (typeof cell === "number" && Number.isFinite(cell) && cell >= 0)
    return Math.round(cell * 100)
  return yield* unreadable(
    `${at.where}'s PERCENTAGE isn't a percentage: ${yield* excerpt(String(cell ?? ""))}`
  )
})

// `label`'s text as the value `known` holds under it, looked up as `keyOf`
// turns it; null when blank.
const knownAt = Effect.fnUntraced(function* <A>(
  at: At,
  label: Label,
  known: ReadonlyMap<string, A>,
  keyOf: (text: string) => Effect.Effect<string> = Effect.succeed
) {
  const text = yield* textAt(at, label)
  if (text === null) return null
  const value = known.get(yield* keyOf(text))
  if (value === undefined)
    return yield* unreadable(
      `${at.where}'s ${label} is unknown: ${yield* excerpt(text)}`
    )
  return value
})

// The classification and KSEI type a row's E gives: Feb–Mar 2026's type
// alone, or a classification and its type.
const investorAt = Effect.fnUntraced(function* (at: At) {
  if (at.layout.investor === "INVESTOR_TYPE")
    return {
      classification: null,
      type: yield* knownAt(at, "INVESTOR_TYPE", KSEI_TYPE_CODES),
    }
  const classification = yield* knownAt(
    at,
    "INVESTOR_CLASSIFICATION",
    BY_CLASSIFICATION,
    squeeze
  )
  return {
    classification,
    type: classification === null ? null : CLASSIFICATIONS[classification].type,
  }
})

// Whether a row with no SHARE_CODE holds only errors and blanks, as Apr
// 2026's #DIV/0! rows do: such a row holds no holder.
const holdsNothing = (cells: ReadRow) =>
  Effect.sync(() =>
    [...cells.values()].every(
      (cell) =>
        cell instanceof CellError ||
        (typeof cell === "string" && cell.trim() === "")
    )
  )

// The stock a row below the header names; undefined for a row holding no
// holder.
// Decision: a row holding anything but errors and blanks must name its stock
// by a SHARE_CODE of text, as the other parses require: a row whose code
// wasn't read would be dropped from its month.
const rowStock = Effect.fnUntraced(function* (
  rowNumber: number,
  cells: ReadRow
) {
  const code = cells.get(CODE)
  if (code instanceof CellError)
    return yield* unreadable(
      `Row ${rowNumber}'s SHARE_CODE holds the error ${yield* excerpt(code.text)}`
    )
  if (typeof code === "number")
    return yield* unreadable(
      `Row ${rowNumber}'s SHARE_CODE isn't text: ${yield* excerpt(String(code))}`
    )
  const stock = code?.trim() ?? ""
  if (stock === "") {
    if (yield* holdsNothing(cells)) return undefined
    return yield* unreadable(`Row ${rowNumber} has no SHARE_CODE`)
  }
  if (stock.length > STOCK_CODE_MAX_LENGTH)
    return yield* unreadable(
      `Row ${rowNumber}'s SHARE_CODE is over ${STOCK_CODE_MAX_LENGTH} characters: ${yield* excerpt(stock)}`
    )
  return stock
})

// The above_1_holding columns a parse writes, in the order a gathered row
// holds them.
const HOLDER_COLUMNS = [
  "stock_code",
  "seq",
  "issuer_name",
  "investor_name",
  "holder_key",
  "classification",
  "investor_type",
  "origin",
  "nationality",
  "domicile",
  "controller",
  "scripless",
  "scrip",
  "total",
  "percentage_hundredths",
] as const

type HolderRow = Record<(typeof HOLDER_COLUMNS)[number], SqlValue>

// One holder row's values but its stock and seq.
const holderRow = Effect.fnUntraced(function* (at: At) {
  const issuer = yield* textAt(at, "ISSUER_NAME")
  if (issuer === null)
    return yield* unreadable(`${at.where} has no ISSUER_NAME`)
  const investor = yield* textAt(at, "INVESTOR_NAME")
  if (investor === null)
    return yield* unreadable(`${at.where} has no INVESTOR_NAME`)
  const { classification, type } = yield* investorAt(at)
  return {
    issuer_name: issuer,
    investor_name: investor,
    holder_key: yield* holderKey(investor),
    classification,
    investor_type: type,
    origin: yield* knownAt(at, "LOCAL_FOREIGN", ORIGINS),
    nationality: yield* textAt(at, "NATIONALITY"),
    domicile: yield* textAt(at, "DOMICILE"),
    controller: at.layout.controller
      ? yield* knownAt(at, "CONTROLLER_OR_AFFILIATE", CONTROLLERS)
      : null,
    scripless: yield* sharesAt(at, "HOLDINGS_SCRIPLESS"),
    scrip: yield* sharesAt(at, "HOLDINGS_SCRIP"),
    total: yield* sharesAt(at, "TOTAL_HOLDING_SHARES"),
    percentage_hundredths: yield* hundredthsAt(at),
  } satisfies Omit<HolderRow, "stock_code" | "seq">
})

// One month's rows, read a row at a time: the header's layout, then a
// holder row per row below it, numbered within its stock in file order.
const parseSheet = Effect.fnUntraced(function* (bytes: Uint8Array) {
  let layout: Found | undefined
  // Each stock's rows so far.
  const seqs = new Map<string, number>()
  let rowCount = 0
  const holders = yield* monthRows("above_1_holding", HOLDER_COLUMNS)
  yield* forEachRow(bytes, (rowNumber, cells) =>
    Effect.gen(function* () {
      if (layout === undefined) {
        layout = yield* headerLayout(rowNumber, cells)
        return
      }
      const stock = yield* rowStock(rowNumber, cells)
      if (stock === undefined) return
      if (rowCount === MAX_ROWS)
        return yield* unreadable(
          `The report lists more than ${MAX_ROWS.toLocaleString("en-US")} holders`
        )
      rowCount++
      const seq = (seqs.get(stock) ?? 0) + 1
      seqs.set(stock, seq)
      const row: HolderRow = {
        stock_code: stock,
        seq,
        ...(yield* holderRow({
          cells,
          layout,
          where: `${stock} (row ${rowNumber})`,
        })),
      }
      yield* holders.add(HOLDER_COLUMNS.map((column) => row[column]))
    })
  )
  if (layout === undefined)
    return yield* unreadable("No header row names SHARE_CODE")
  if (rowCount === 0) return yield* unreadable("The report has no holders")
  return { stockCount: seqs.size, tables: [yield* holders.gathered] }
})

// Parses one archived report and replaces its data date's ≥1% holders with
// it, recording the version it came from. The number of stocks parsed.
export const parseAbove1Month = Effect.fnUntraced(function* (
  dataDate: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { stockCount, tables } = yield* parseSheet(bytes)
  yield* replaceMonth({
    dateColumn: "data_date",
    date: dataDate,
    tables,
    record: {
      table: "above_1_month",
      values: {
        sha256,
        parser_version: ABOVE_1_PARSER_VERSION,
        parsed_at: parsedAt,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stockCount
})

// Its parsed tables. It has no table a row per stock: the parse coverage,
// which counts `stock`'s rows, shows no above-1% grid.
export const ABOVE_1_TABLES: MonthTables = {
  month: "above_1_month",
  stock: "above_1_holding",
  dateColumn: "data_date",
}
