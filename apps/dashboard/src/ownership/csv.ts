import type { AsOf } from "./as-of"
import { holderKey } from "./holder-key"

/*
 * Parsing and structural checks. Pure. A file is read a row at a time, because holding a 32 MB
 * file's cells and rows at once exceeds a Worker's 128 MiB.
 */

/** The operator's `_scripts/kirim.py`, outside this repo, sends these names. Change the two together. */
export const DATASETS = [
  "lima-persen",
  "satu-persen",
  "tipe",
  "klasifikasi",
] as const
export type Dataset = (typeof DATASETS)[number]

/** `requiredText` is a column NOT NULL in the dataset's table, so an empty cell refuses the file. */
type ColumnKind = "requiredText" | "text" | "integer" | "real"

type Format = {
  /** The dataset's D1 table. */
  readonly table: string
  /** The CSV's columns, in order, by how a cell is read. */
  readonly columns: Readonly<Record<string, ColumnKind>>
  /** The column a stored `holder_key` is derived from, on holding lines. */
  readonly holderName?: string
  /** A trailing column in `columns` that files carry through one as-of, and later ones lack. */
  readonly older?: { readonly column: string; readonly through: AsOf }
}

/**
 * `flags.ts` reads these columns by name. Each `requiredText` is NOT NULL in `migrations/0001_ownership.sql`. The column names match the
 * operator's converter, outside this repo, whose output the routine sends. Change them together.
 */
const FORMATS = {
  "lima-persen": {
    table: "holding_lines_5",
    columns: {
      as_of: "requiredText",
      previous_date: "text",
      holder_no: "integer",
      symbol: "requiredText",
      issuer_name: "text",
      account_holder: "text",
      holder_name: "text",
      account_name: "text",
      nationality: "text",
      domicile: "text",
      status: "text",
      previous_shares: "integer",
      previous_combined_shares: "integer",
      previous_percent: "real",
      shares: "integer",
      combined_shares: "integer",
      percent: "real",
      change: "integer",
    },
    holderName: "holder_name",
  },
  "satu-persen": {
    table: "holding_lines_1",
    columns: {
      as_of: "requiredText",
      symbol: "requiredText",
      issuer_name: "text",
      investor_name: "text",
      classification: "text",
      local_foreign: "text",
      nationality: "text",
      domicile: "text",
      scripless: "integer",
      scrip: "integer",
      total: "integer",
      percent: "real",
      investor_type_code: "text",
    },
    holderName: "investor_name",
    older: { column: "investor_type_code", through: "2026-03-31" as AsOf },
  },
  tipe: {
    table: "breakdown_by_type",
    columns: {
      as_of: "requiredText",
      symbol: "requiredText",
      number_of_shares: "integer",
      side: "text",
      category: "requiredText",
      band: "requiredText",
      shares: "integer",
      total_scripless: "integer",
    },
  },
  klasifikasi: {
    table: "breakdown_by_classification",
    columns: {
      as_of: "requiredText",
      symbol: "requiredText",
      issuer_name: "text",
      side: "text",
      category: "requiredText",
      shares: "integer",
      total_scripless: "integer",
    },
  },
} as const satisfies Record<Dataset, Format>

export const isDataset = (value: string | null): value is Dataset =>
  value !== null && Object.hasOwn(FORMATS, value)

/** Where a file's CSV is kept in R2. */
export const csvKey = (dataset: Dataset, csvSha256: string) =>
  `ownership/${dataset}/${csvSha256}.csv`

export const tableOf = (dataset: Dataset): string => FORMATS[dataset].table

/** The columns of a stored row, in the order `Row` carries them to the store. */
export const storedColumns = (dataset: Dataset): Array<string> => {
  const format: Format = FORMATS[dataset]
  return [
    ...Object.keys(format.columns),
    ...(format.holderName === undefined ? [] : ["holder_key"]),
  ]
}

/**
 * A row's cells as published. Generic deliberately, since columns differ per dataset: `as_of` and
 * `symbol` stay unbranded cells here. `checkImport` is the boundary that compares `as_of` against
 * the request's As-of, and `symbol` is never parsed (see PublishedSymbol).
 */
export type Row = Readonly<Record<string, string | number | null>>

type ImportCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const reject = (reason: string): ImportCheck => ({ ok: false, reason })

const MALFORMED = "a field has malformed quoting or a stray carriage return"

/** A quoted cell's text and the index after its closing quote, or null when it never closes. */
const readQuoted = (
  text: string,
  start: number
): { readonly cell: string; readonly next: number } | null => {
  let cell = ""
  for (let i = start; i < text.length; i++) {
    if (text[i] !== '"') cell += text[i]
    else if (text[i + 1] === '"') {
      cell += '"'
      i++
    } else return { cell, next: i + 1 }
  }
  return null
}

type Field = {
  readonly cell: string
  readonly next: number
  readonly endsLine: boolean
}

/** The field whose text stops at `at`, or null when anything but a delimiter is there. */
const endField = (text: string, cell: string, at: number): Field | null => {
  if (at === text.length) return { cell, next: at, endsLine: true }
  if (text[at] === ",") return { cell, next: at + 1, endsLine: false }
  if (text[at] === "\n") return { cell, next: at + 1, endsLine: true }
  return text.startsWith("\r\n", at)
    ? { cell, next: at + 2, endsLine: true }
    : null
}

/** The cell starting at `start`, or null when it is malformed. */
const readField = (text: string, start: number): Field | null => {
  if (text[start] === '"') {
    const quoted = readQuoted(text, start + 1)
    return quoted && endField(text, quoted.cell, quoted.next)
  }
  let cell = ""
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"') return null
    if (c === "," || c === "\n" || c === "\r") return endField(text, cell, i)
    cell += c
  }
  return { cell, next: text.length, endsLine: true }
}

/** RFC 4180 lines of cells, in order. A null is the last, when a field is malformed. */
function* parseLines(text: string): Generator<Array<string> | null, undefined> {
  let line: Array<string> = []
  let i = 0
  while (i < text.length) {
    const field = readField(text, i)
    if (field === null) {
      yield null
      return
    }
    line.push(field.cell)
    i = field.next
    if (field.endsLine) {
      yield line
      line = []
    }
  }
  if (line.length > 0) yield [...line, ""]
}

const INTEGER = /^-?\d+$/
const REAL = /^-?\d+(\.\d+)?$/

/** A cell's value, or undefined when refused. Empty is valid unless required, and is not zero. */
const readCell = (
  kind: ColumnKind,
  cell: string
): string | number | null | undefined => {
  if (cell === "") return kind === "requiredText" ? undefined : null
  if (kind === "text" || kind === "requiredText") return cell
  if (!(kind === "integer" ? INTEGER : REAL).test(cell)) return undefined
  const value = Number(cell)
  const valid = kind === "integer" ? Number.isSafeInteger : Number.isFinite
  return valid(value) ? value : undefined
}

type Column = readonly [name: string, kind: ColumnKind]

/** The columns a file with this header carries, or null when the header is not the dataset's. */
const columnsOf = (
  format: Format,
  header: ReadonlyArray<string> | undefined
): ReadonlyArray<Column> | null => {
  const all = Object.entries(format.columns)
  const matches = (columns: ReadonlyArray<Column>) =>
    header?.length === columns.length &&
    columns.every(([name], i) => header[i] === name)
  if (matches(all)) return all
  const newer = all.filter(([name]) => name !== format.older?.column)
  return matches(newer) ? newer : null
}

/** A line's row, typed by column, or why it is refused. */
const readRow = (
  format: Format,
  columns: ReadonlyArray<Column>,
  line: ReadonlyArray<string>,
  rowNo: number
): Row | string => {
  if (line.length !== columns.length)
    return `row ${rowNo} has ${line.length} cells`
  const row: Record<string, string | number | null> = {}
  for (const [i, [name, kind]] of columns.entries()) {
    const cell = line[i] ?? ""
    const value = readCell(kind, cell)
    if (value === undefined)
      return `row ${rowNo}: ${name} ${cell === "" ? "is empty" : "does not parse"}`
    row[name] = value
  }
  if (format.holderName !== undefined) {
    const name = row[format.holderName]
    row.holder_key = typeof name === "string" ? holderKey(name) : null
  }
  return row
}

/** The file's rows in order, typed by column. A string is the last, saying why a line is refused. */
function* readRows(
  dataset: Dataset,
  text: string
): Generator<Row | string, undefined> {
  const format: Format = FORMATS[dataset]
  const lines = parseLines(text)
  const { value: header } = lines.next()
  if (header === null) {
    yield MALFORMED
    return
  }
  const columns = columnsOf(format, header)
  if (columns === null) {
    yield `columns differ from ${dataset}'s`
    return
  }
  let rowNo = 0
  for (const line of lines) {
    rowNo++
    const row =
      line === null ? MALFORMED : readRow(format, columns, line, rowNo)
    yield row
    if (typeof row === "string") return
  }
}

/** Rows `start` up to `end`, counted from 0, reading no further. Throws why a line is refused. */
export const readChunk = (
  dataset: Dataset,
  text: string,
  start: number,
  end: number
): ReadonlyArray<Row> => {
  const chunk: Array<Row> = []
  let rowNo = 0
  for (const row of readRows(dataset, text)) {
    if (typeof row === "string") throw new Error(row)
    if (rowNo >= start) chunk.push(row)
    rowNo++
    if (rowNo === end) break
  }
  return chunk
}

/** Why this as-of should not have these columns, or null when it should. */
const olderColumnFault = (
  { older }: Format,
  columns: ReadonlyArray<string>,
  asOf: AsOf
): string | null => {
  if (older === undefined) return null
  const carries = columns.includes(older.column)
  if (carries === asOf <= older.through) return null
  return carries
    ? `${older.column} ends at ${older.through}, and this file is ${asOf}`
    : `${older.column} is missing, and ${asOf} carries it`
}

const hasMalformedField = (text: string) => {
  for (const line of parseLines(text)) if (line === null) return true
  return false
}

/**
 * That every row reads and that the file is the one its request headers describe, holding one row
 * at a time. A malformed field anywhere outranks any other reason, so a refused file is read on.
 */
export const checkImport = (
  dataset: Dataset,
  text: string,
  declared: { readonly asOf: AsOf; readonly rowCount: number }
): ImportCheck => {
  let rowCount = 0
  let strayAsOf: number | null = null
  for (const row of readRows(dataset, text)) {
    if (typeof row === "string")
      return reject(hasMalformedField(text) ? MALFORMED : row)
    rowCount++
    if (strayAsOf === null && row.as_of !== declared.asOf) strayAsOf = rowCount
  }
  const header = parseLines(text).next().value ?? []
  const fault = olderColumnFault(FORMATS[dataset], header, declared.asOf)
  if (fault !== null) return reject(fault)
  if (rowCount !== declared.rowCount)
    return reject(
      `holds ${rowCount} rows, not ${declared.rowCount} as declared`
    )
  return strayAsOf === null
    ? { ok: true }
    : reject(`row ${strayAsOf}: as_of differs from ${declared.asOf}`)
}
