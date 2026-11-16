import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_SHARED_STRINGS_BYTES } from "@/server/holdings/xlsx"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { bytesOf } from "./at-cap.ts"
import { PARSE_HEAP_MIB, parseInBoundedHeap } from "./bounded-heap.ts"
import {
  columnLetters,
  SHARED_STRINGS,
  SHEET,
  sharedItems,
} from "./workbook.ts"
import { zipOf } from "./zip-of.ts"

const TYPE_LABELS = [
  "CP: Corporate (perusahaan terbatas)",
  "FD: Foundation (yayasan)",
  "IB: Financial Institution (institusi keuangan)",
  "ID: Individual",
  "IS: Insurance (asuransi)",
  "MF: Mutual Fund (reksa dana)",
  "OT: Others",
  "PF: Pension Fund (pengelola dana pensiun)",
  "SC: Securities Company (perusahaan sekuritas)",
]

// Jan 2026 on: D to AM, each type's <5% and >=5% columns, domestic then
// foreign, then the total in AN.
const FIRST_TYPE = 3
const TYPE_COLUMNS = 2 * 2 * TYPE_LABELS.length
const TOTAL = FIRST_TYPE + TYPE_COLUMNS

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="str"><v>${text}</v></c>`

// The split layout's 3 header rows.
const HEADER = [
  `<row r="1">${[
    inline("A1", "DATE"),
    inline("B1", "STOCK_CODE"),
    inline("C1", "NUMBER_OF_SHARES"),
    inline(`${columnLetters(FIRST_TYPE)}1`, "DOMESTIC"),
    inline(`${columnLetters(FIRST_TYPE + TYPE_COLUMNS / 2)}1`, "FOREIGN"),
    inline(`${columnLetters(TOTAL)}1`, "TOTAL SCRIPLESS"),
  ].join("")}</row>`,
  `<row r="2">${[...TYPE_LABELS, ...TYPE_LABELS]
    .map((label, type) =>
      inline(`${columnLetters(FIRST_TYPE + 2 * type)}2`, label)
    )
    .join("")}</row>`,
  `<row r="3">${Array.from({ length: TYPE_COLUMNS }, (_, column) =>
    inline(
      `${columnLetters(FIRST_TYPE + column)}3`,
      column % 2 === 0 ? "&lt;5%" : "&gt;=5%"
    )
  ).join("")}</row>`,
].join("")

// Row `row`: stock S<row>, holding a share in every type column, so it
// stores a holding for each type of each origin and each combined.
const stockRow = (row: number) => {
  const cells = [inline(`B${row}`, `S${row}`), `<c r="C${row}"><v>1</v></c>`]
  for (let column = FIRST_TYPE; column < TOTAL; column++)
    cells.push(`<c r="${columnLetters(column)}${row}"><v>1</v></c>`)
  cells.push(`<c r="${columnLetters(TOTAL)}${row}"><v>${TYPE_COLUMNS}</v></c>`)
  return `<row r="${row}">${cells.join("")}</row>`
}

// Row `row`, one cell in A holding 0: a row's shortest XML with a value.
const shortRow = (row: number) =>
  `<row r="${row}"><c r="A${row}"><v>0</v></c></row>`

const SHEET_HEAD = "<worksheet><sheetData>"
const SHEET_TAIL = "</sheetData></worksheet>"

// The largest sheet: the header rows, then `stocks` stock rows, or as many
// as fit, then as many `shortRow`s as fit.
const largestSheet = (stocks: number) => {
  const rows = [HEADER]
  let size = SHEET_HEAD.length + SHEET_TAIL.length + HEADER.length
  let row = 4
  for (; row <= stocks + 3; row++) {
    if (size + stockRow(row).length > MAX_ENTRY_BYTES) break
    rows.push(stockRow(row))
    size += stockRow(row).length
  }
  for (; size + shortRow(row).length <= MAX_ENTRY_BYTES; row++) {
    rows.push(shortRow(row))
    size += shortRow(row).length
  }
  return bytesOf(SHEET_HEAD, rows.join(""), SHEET_TAIL)
}

// Distinct strings until the shared strings reach their cap.
const paddedStrings = () => {
  const strings: Array<string> = []
  const entryBytes = (string: string) => `<si><t>${string}</t></si>`.length
  let size = "<sst></sst>".length
  for (
    let index = 0;
    size + entryBytes(`S${index}`) <= MAX_SHARED_STRINGS_BYTES;
    index++
  ) {
    strings.push(`S${index}`)
    size += entryBytes(`S${index}`)
  }
  return bytesOf(`<sst>${sharedItems(strings)}</sst>`)
}

const SHAPES: ReadonlyArray<{
  readonly shape: string
  readonly stocks: number
  readonly posts: string
}> = [
  {
    shape: "more stocks than a month can list",
    stocks: Number.POSITIVE_INFINITY,
    posts: "The report lists more than 2,000 stocks",
  },
  {
    shape:
      "the most stocks a month can list, each holding in every type column, padded with value rows and shared strings",
    stocks: 2_000,
    posts: "Parsed 2000 stocks",
  },
]

describe(`the largest investor-type report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  for (const { shape, stocks, posts } of SHAPES)
    it.effect(
      shape,
      () =>
        Effect.gen(function* () {
          const report = yield* zipOf([
            [SHARED_STRINGS, paddedStrings()],
            [SHEET, largestSheet(stocks)],
          ])
          assert.strictEqual(
            yield* parseInBoundedHeap("investor-type", report),
            posts
          )
        }),
      { timeout: 30_000 }
    )
})
