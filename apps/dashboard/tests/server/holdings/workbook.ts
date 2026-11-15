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
