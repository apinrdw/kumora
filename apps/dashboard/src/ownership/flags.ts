import type { Dataset, Row } from "./csv"

/*
 * The row flags. Pure: stored rows in, the rows failing a check out. Figures are never changed.
 * Every rule works within one symbol, so a caller can flag a file a few symbols at a time.
 */

type FlagRule =
  | "row_sum"
  | "line_sum"
  | "category_sum"
  | "duplicate_key"
  | "empty_value"

export type RowFlag = {
  readonly rowNo: number
  readonly rule: FlagRule
  readonly detail: string
}

/**
 * A row as stored, with its number in the file. The rules below read columns by the names `FORMATS`
 * defines in `csv.ts`. Change the two together: a renamed column would raise no flag, not an error.
 */
export type StoredRow = Row & { readonly row_no: number }

type Check = (rows: ReadonlyArray<StoredRow>) => Array<RowFlag>

/** 1%: `scripless + scrip = total`. An empty figure is not zero, so there is no sum to check. */
const rowSum: Check = (rows) =>
  rows.flatMap((row) => {
    const { scripless, scrip, total } = row
    if (
      typeof scripless !== "number" ||
      typeof scrip !== "number" ||
      typeof total !== "number" ||
      scripless + scrip === total
    )
      return []
    return {
      rowNo: row.row_no,
      rule: "row_sum",
      detail: `${scripless} + ${scrip} is not ${total}`,
    }
  })

/** Rows sharing a key, each group in the order given. */
const groupBy = (
  rows: ReadonlyArray<StoredRow>,
  keyOf: (row: StoredRow) => string
): Array<Array<StoredRow>> => {
  const groups = new Map<string, Array<StoredRow>>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  return [...groups.values()]
}

/**
 * 5%: the holding lines sharing a `holder_no` under a symbol. A line with no number stands alone.
 * `line_sum` groups by this published number, whereas a Holder position groups by `holder_key`.
 */
const linesByHolderNumber = (rows: ReadonlyArray<StoredRow>) =>
  groupBy(rows, (row) =>
    JSON.stringify([row.symbol, row.holder_no ?? `row ${row.row_no}`])
  )

/** The figures of these rows' column, or null when any is empty. */
const figures = (lines: ReadonlyArray<StoredRow>, column: string) => {
  const values = lines.map((row) => row[column])
  return values.every((value) => typeof value === "number")
    ? (values as ReadonlyArray<number>)
    : null
}

const sum = (values: ReadonlyArray<number>) =>
  values.reduce((total, value) => total + value, 0)

/** 5%: the `shares` of the lines under one holder number sum to `combined_shares`, when none is empty. */
const lineSum: Check = (rows) =>
  linesByHolderNumber(rows).flatMap((lines) => {
    const first = lines[0]
    const combined = first?.combined_shares
    const shares = figures(lines, "shares")
    if (first === undefined || typeof combined !== "number" || shares === null)
      return []
    const total = sum(shares)
    if (total === combined) return []
    return {
      rowNo: first.row_no,
      rule: "line_sum",
      detail: `lines sum to ${total}, not ${combined}`,
    }
  })

/** `tipe`, `klasifikasi`: a symbol's categories sum to `total_scripless`. Empty adds nothing. */
const categorySum: Check = (rows) =>
  groupBy(rows, (row) => String(row.symbol)).flatMap((categories) => {
    const total = sum(
      categories.flatMap((row) =>
        typeof row.shares === "number" ? [row.shares] : []
      )
    )
    const differing = categories
      .map((row) => row.total_scripless)
      .find((published) => typeof published === "number" && published !== total)
    const first = categories[0]
    if (first === undefined || differing === undefined) return []
    return {
      rowNo: first.row_no,
      rule: "category_sum",
      detail: `categories sum to ${total}, not ${differing}`,
    }
  })

/** Natural keys only detect a repeat: every later one is flagged, and all are kept. */
const duplicateKey =
  (columns: ReadonlyArray<string>): Check =>
  (rows) =>
    groupBy(rows, (row) =>
      JSON.stringify(columns.map((column) => row[column]))
    ).flatMap(([first, ...repeats]) =>
      repeats.map((repeat) => ({
        rowNo: repeat.row_no,
        rule: "duplicate_key",
        detail: `repeats row ${first?.row_no}`,
      }))
    )

/** One flag per row, as a rule flags a row once, naming every empty column. */
const emptyFlag = (
  row: StoredRow,
  columns: ReadonlyArray<string>
): Array<RowFlag> => {
  const empty = columns.filter((column) => row[column] === null)
  return empty.length === 0
    ? []
    : [
        {
          rowNo: row.row_no,
          rule: "empty_value",
          detail: `${empty.join(", ")} is empty`,
        },
      ]
}

/** 5%: every line has `shares`. Only the first line under a holder number has `combined_shares`. */
const emptyHoldingLineFigure: Check = (rows) =>
  linesByHolderNumber(rows).flatMap((lines) =>
    lines.flatMap((line, index) =>
      emptyFlag(line, index === 0 ? ["shares", "combined_shares"] : ["shares"])
    )
  )

/** 1%: `scrip` and `scripless` can be empty on their own; `total` is the row's count. */
const emptyTotal: Check = (rows) =>
  rows.flatMap((row) => emptyFlag(row, ["total"]))

const CHECKS: Readonly<Record<Dataset, ReadonlyArray<Check>>> = {
  "lima-persen": [lineSum, emptyHoldingLineFigure],
  "satu-persen": [
    rowSum,
    emptyTotal,
    duplicateKey([
      "as_of",
      "symbol",
      "investor_name",
      "classification",
      "local_foreign",
      "nationality",
      "domicile",
    ]),
  ],
  tipe: [
    categorySum,
    duplicateKey(["as_of", "symbol", "side", "category", "band"]),
  ],
  klasifikasi: [
    categorySum,
    duplicateKey(["as_of", "symbol", "side", "category"]),
  ],
}

/** Every flag on these rows, given in file order and holding all the rows of each symbol. */
export const flagRows = (
  dataset: Dataset,
  rows: ReadonlyArray<StoredRow>
): Array<RowFlag> => CHECKS[dataset].flatMap((check) => check(rows))
