// Reads the first worksheet of an .xlsx by hand: the zip's central directory,
// workerd's DecompressionStream for the two XML parts, then regexes, since
// workerd has no DOMParser. It handles what IDX's classification reports
// hold: shared strings and plain numbers, no formulas or inline strings.
// Decision: no dependency. SheetJS adds 380 KiB and is 5× slower; exceljs
// hangs a reused isolate. See apinrdw/kumora#351.
import { Effect, Schema } from "effect"

class XlsxUnreadable extends Schema.TaggedError<XlsxUnreadable>()(
  "XlsxUnreadable",
  { message: Schema.String }
) {}

export type Cell = string | number | null

const unreadable = (message: string) => new XlsxUnreadable({ message })

const SHEET = "xl/worksheets/sheet1.xml"
const SHARED_STRINGS = "xl/sharedStrings.xml"

interface Entry {
  readonly method: number
  readonly size: number
  readonly offset: number
}

// The zip's entries by name, from the End of Central Directory record back.
// ZIP64 isn't handled: the reports are well under 4 GB.
const zipEntries = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) return undefined
  const entries = new Map<string, Entry>()
  let at = view.getUint32(eocd + 16, true)
  const count = view.getUint16(eocd + 10, true)
  const names = new TextDecoder()
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return undefined
    const nameLength = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    if (local + 30 > bytes.length) return undefined
    entries.set(names.decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset:
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true),
    })
    at +=
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
  }
  return entries
}

const entryText = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  entries: ReadonlyMap<string, Entry>,
  name: string
) {
  const entry = entries.get(name)
  if (entry === undefined) return yield* unreadable(`The file has no ${name}`)
  const raw = bytes.slice(entry.offset, entry.offset + entry.size)
  if (entry.method === 0) return new TextDecoder().decode(raw)
  if (entry.method !== 8)
    return yield* unreadable(
      `${name} uses zip compression method ${entry.method}`
    )
  return yield* Effect.tryPromise({
    try: () =>
      new Response(
        new Blob([raw])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"))
      ).text(),
    catch: () => unreadable(`${name} doesn't inflate`),
  })
})

const decodeXml = (text: string) =>
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

// Every <si>'s text, its rich-text runs' <t>s joined.
const sharedStrings = (xml: string) =>
  [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, item]) =>
    decodeXml(
      [...(item ?? "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map(([, text]) => text)
        .join("")
    )
  )

// "AB" → 27, the 0-based column of a cell reference's letters.
const columnIndex = (letters: string) => {
  let index = 0
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64
  return index - 1
}

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
  if (!/\bt="s"/.test(attributes)) return decodeXml(value)
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
    const column = columnIndex(ref[1] ?? "")
    while (cells.length < column) cells.push(null)
    cells[column] = yield* cellValue(attributes, content, strings)
  }
  return cells
})

// The first worksheet's rows by 1-based row number, each a dense array of
// its cells by column: a shared string, a number, or null for no value.
export const readSheet = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const entries = zipEntries(bytes)
  if (entries === undefined) return yield* unreadable("The file isn't a zip")
  const strings = sharedStrings(
    yield* entryText(bytes, entries, SHARED_STRINGS)
  )
  const sheet = yield* entryText(bytes, entries, SHEET)
  const rows = new Map<number, Array<Cell>>()
  for (const [, rowNumber = "", inner = ""] of sheet.matchAll(ROW))
    rows.set(Number(rowNumber), yield* rowCells(rowNumber, inner, strings))
  return rows
})
