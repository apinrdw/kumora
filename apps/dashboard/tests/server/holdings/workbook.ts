import { CLASSIFICATIONS } from "@/domain/holdings"

import { zipOf } from "./zip-of.ts"

const text = (xml: string) => new TextEncoder().encode(xml)

// An .xlsx whose first worksheet holds `rows`, with `strings` shared.
export const workbook = (rows: string, strings: ReadonlyArray<string> = []) =>
  zipOf([
    [
      "xl/sharedStrings.xml",
      text(
        `<sst>${strings.map((string) => `<si><t>${string}</t></si>`).join("")}</sst>`
      ),
    ],
    [
      "xl/worksheets/sheet1.xml",
      text(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
    ],
  ])

// The bytes `workbook` adds around its rows.
export const WORKSHEET_BYTES = "<worksheet><sheetData></sheetData></worksheet>"
  .length

// 27 → "AB", a 0-based column's letters.
export const columnLetters = (column: number) => {
  let letters = ""
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  return letters
}

const HEADERS = Object.values(CLASSIFICATIONS).map(({ header }) => header)

// Sep 2026's layout: each classification as Local_ and as Foreign_, as
// `workbook`'s shared strings.
export const SPLIT_LABELS = [
  "DATE",
  "SHARE_CODE",
  "ISSUER_NAME",
  ...HEADERS.map((header) => `Local_${header}`),
  ...HEADERS.map((header) => `Foreign_${header}`),
  "Total Scripless",
]

// Row 1, naming SPLIT_LABELS by their shared string.
export const SPLIT_HEADER_ROW = `<row r="1">${SPLIT_LABELS.map(
  (_, column) => `<c r="${columnLetters(column)}1" t="s"><v>${column}</v></c>`
).join("")}</row>`
