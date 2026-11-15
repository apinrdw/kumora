// Reads the first worksheet of an .xlsx by hand: its two XML parts out of
// the zip (zip.ts), then regexes, since workerd has no DOMParser. It handles what IDX's classification reports
// hold: shared strings and plain numbers, no formulas or inline strings.
// Decision: no dependency. SheetJS adds 380 KiB and is 5× slower; exceljs
// hangs a reused isolate. See apinrdw/kumora#351.
import { Effect, Schema } from "effect"

import { entryText, zipEntries } from "./zip.ts"

class XlsxUnreadable extends Schema.TaggedError<XlsxUnreadable>()(
  "XlsxUnreadable",
  { message: Schema.String }
) {}

export type Cell = string | number | null

const unreadable = (message: string) => new XlsxUnreadable({ message })

const SHEET = "xl/worksheets/sheet1.xml"
const SHARED_STRINGS = "xl/sharedStrings.xml"

const decodeXml = (text: string) =>
  Effect.sync(() =>
    text.replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
      (_, hex, dec, name) =>
        hex !== undefined
          ? String.fromCodePoint(Number.parseInt(hex, 16))
          : dec !== undefined
            ? String.fromCodePoint(Number.parseInt(dec, 10))
            : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
                (name as string).toLowerCase() as "amp"
              ]
    )
  )

// Every <si>'s text, its rich-text runs' <t>s joined.
const sharedStrings = Effect.fnUntraced(function* (xml: string) {
  const strings: Array<string> = []
  for (const [, item = ""] of xml.matchAll(/<si>([\s\S]*?)<\/si>/g))
    strings.push(
      yield* decodeXml(
        [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map(([, text]) => text)
          .join("")
      )
    )
  return strings
})

// "AB" → 27, the 0-based column of a cell reference's letters.
const columnIndex = (letters: string) =>
  Effect.sync(() => {
    let index = 0
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64
    return index - 1
  })

const ROW = /<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g
const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const REF = /\br="([A-Z]+)\d+"/
const VALUE = /<v>([\s\S]*?)<\/v>/

// One cell's value: a shared string (`t="s"`), other typed text, a number,
// or null when it has none.
const cellValue = Effect.fnUntraced(function* (
  attributes: string,
  content: string,
  strings: ReadonlyArray<string>
) {
  const value = VALUE.exec(content)?.[1]
  if (value === undefined) return null
  if (!/\bt="/.test(attributes)) return Number(value)
  if (!/\bt="s"/.test(attributes)) return yield* decodeXml(value)
  const text = strings[Number(value)]
  if (text === undefined)
    return yield* unreadable(`A cell names no shared string: ${attributes}`)
  return text
})

// A row's cells, dense by column: a column with no cell is null.
const rowCells = Effect.fnUntraced(function* (
  rowNumber: string,
  inner: string,
  strings: ReadonlyArray<string>
) {
  const cells: Array<Cell> = []
  for (const [, attributes = "", content = ""] of inner.matchAll(CELL)) {
    const ref = REF.exec(attributes)
    if (ref === null)
      return yield* unreadable(`A cell in row ${rowNumber} has no reference`)
    const column = yield* columnIndex(ref[1] ?? "")
    while (cells.length < column) cells.push(null)
    cells[column] = yield* cellValue(attributes, content, strings)
  }
  return cells
})

// The first worksheet's rows by 1-based row number, each a dense array of
// its cells by column: a shared string, a number, or null for no value.
export const readSheet = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const { strings, sheet } = yield* Effect.gen(function* () {
    const entries = yield* zipEntries(bytes)
    return {
      strings: yield* sharedStrings(
        yield* entryText(bytes, entries, SHARED_STRINGS)
      ),
      sheet: yield* entryText(bytes, entries, SHEET),
    }
  }).pipe(
    Effect.catchTag("ZipUnreadable", ({ message }) =>
      Effect.fail(unreadable(message))
    )
  )
  const rows = new Map<number, Array<Cell>>()
  for (const [, rowNumber = "", inner = ""] of sheet.matchAll(ROW))
    rows.set(Number(rowNumber), yield* rowCells(rowNumber, inner, strings))
  return rows
})
