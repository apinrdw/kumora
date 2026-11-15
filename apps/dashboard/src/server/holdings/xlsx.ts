// Reads the first worksheet of an .xlsx by hand: its two XML parts out of
// the zip (zip.ts), then regexes, since workerd has no DOMParser. It reads
// text and numbers, and refuses any other cell.
// Decision: no dependency. SheetJS adds 380 KiB and is 5× slower; exceljs
// hangs a reused isolate. See apinrdw/kumora#351.
import { Effect, Schema } from "effect"

import { excerpt } from "./excerpt.ts"
import { entryText, zipEntries } from "./zip.ts"

class XlsxUnreadable extends Schema.TaggedError<XlsxUnreadable>()(
  "XlsxUnreadable",
  { message: Schema.String }
) {}

export type Cell = string | number

// A row's cells by 0-based column. A column with no value has no entry, so
// a row holds only what its XML spells out.
export type Row = ReadonlyMap<number, Cell>

const unreadable = (message: string) => new XlsxUnreadable({ message })

const SHEET = "xl/worksheets/sheet1.xml"
const SHARED_STRINGS = "xl/sharedStrings.xml"

// Decision: the shared strings inflate to at most 1 MiB, 16× Oct 2026's
// 64 KB, and the sheet to MAX_ENTRY_BYTES. A parse holds both as text at
// once, each up to twice its bytes when a character takes two: two 8 MiB
// parts took past 48 MiB.
export const MAX_SHARED_STRINGS_BYTES = 1024 * 1024

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

// `text` with its references replaced by their characters, refused when one
// names no character: past U+10FFFF, or a UTF-16 surrogate.
const decodeXml = (text: string) =>
  Effect.suspend(() => {
    let unnamed: string | undefined
    const decoded = text.replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
      (reference, hex, dec, name) => {
        if (name !== undefined)
          return NAMED[(name as string).toLowerCase() as keyof typeof NAMED]
        const point =
          hex !== undefined
            ? Number.parseInt(hex, 16)
            : Number.parseInt(dec, 10)
        if (point <= 0x10ffff && (point < 0xd800 || point > 0xdfff))
          return String.fromCodePoint(point)
        unnamed ??= reference
        return ""
      }
    )
    return unnamed === undefined
      ? Effect.succeed(decoded)
      : Effect.flatMap(excerpt(unnamed), (quoted) =>
          Effect.fail(unreadable(`${quoted} names no character`))
        )
  })

// A tag's attributes, and its content: undefined when it closes itself.
interface Element {
  readonly attributes: string
  readonly content: string | undefined
}

// Each <`name`> of `xml`, in order, or null in place of the first one never
// closed, which ends the walk.
// Decision: tags are found by indexOf and walked plainly, one at a time: a
// lazy `[\s\S]*?` regex rescanned to the end from each unclosed tag, 600,000
// rich-text runs matched at once took past 48 MiB, and an Effect per tag read
// Oct 2026's sheet in 157 ms, not 55 (Node 26, median of 30, 2026-11-15).
function* elements(xml: string, name: string): Generator<Element | null, void> {
  const open = `<${name}`
  const close = `</${name}>`
  for (let at = xml.indexOf(open); at !== -1; at = xml.indexOf(open, at)) {
    at += open.length
    // `<c` opens a cell, not a `<col`.
    if (!/[\s/>]/.test(xml.charAt(at))) continue
    const tagEnd = xml.indexOf(">", at)
    if (tagEnd === -1) {
      yield null
      return
    }
    const attributes = xml.slice(at, tagEnd)
    at = tagEnd + 1
    if (attributes.endsWith("/")) {
      yield { attributes, content: undefined }
      continue
    }
    const end = xml.indexOf(close, at)
    if (end === -1) {
      yield null
      return
    }
    yield { attributes, content: xml.slice(at, end) }
    at = end + close.length
  }
}

const neverClosed = (name: string) =>
  Effect.fail(unreadable(`A <${name}> is never closed`))

// A <si> or <is>'s text: its rich-text runs' <t>s joined.
const stringText = Effect.fnUntraced(function* (content: string) {
  let text = ""
  for (const run of elements(content, "t")) {
    if (run === null) return yield* neverClosed("t")
    text += run.content ?? ""
  }
  return yield* decodeXml(text)
})

// Every <si>'s text.
const sharedStrings = Effect.fnUntraced(function* (xml: string) {
  const strings: Array<string> = []
  for (const item of elements(xml, "si")) {
    if (item === null) return yield* neverClosed("si")
    strings.push(yield* stringText(item.content ?? ""))
  }
  return strings
})

// Decision: a cell's column is at most XFD, Excel's last, so a row holds at
// most 16,384 cells however many its XML spells out.
const LAST_COLUMN = { letters: "XFD", index: 16_383 }

// "AB" → 27, the 0-based column of a cell reference's letters; past
// LAST_COLUMN for more letters than it has.
const columnIndex = (letters: string) => {
  if (letters.length > LAST_COLUMN.letters.length) return LAST_COLUMN.index + 1
  let index = 0
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64
  return index - 1
}

const ROW_NUMBER = /\br="(\d+)"/
const REF = /\br="(([A-Z]+)\d+)"/
const TYPE = /\bt="([^"]*)"/

// The cell types read.
const READ_TYPES: ReadonlySet<string> = new Set(["s", "str", "inlineStr", "n"])

// One cell's value, undefined when it holds none: a shared string (`t="s"`),
// text (`t="str"`, or `t="inlineStr"` from its <is>), or a number (`t="n"`,
// or no type).
// Decision: a cell of any other type, or one holding something but no value,
// fails the report: a boolean, error or date names no stock or share count,
// an error read as text stored `#N/A` as a stock, and an inline string read
// as no value dropped a stock while its month was replaced.
const cellValue = Effect.fnUntraced(function* (
  ref: string,
  attributes: string,
  content: string,
  strings: ReadonlyArray<string>
) {
  const type = TYPE.exec(attributes)?.[1] ?? "n"
  if (!READ_TYPES.has(type))
    return yield* unreadable(
      `Cell ${yield* excerpt(ref)}'s type is "${yield* excerpt(type)}": a cell is read only as a shared string, a string, an inline string or a number`
    )
  const name = type === "inlineStr" ? "is" : "v"
  const element = elements(content, name).next().value
  if (element === null) return yield* neverClosed(name)
  const text = element?.content
  if (text === undefined) {
    if (content.trim() === "") return undefined
    return yield* unreadable(
      `Cell ${yield* excerpt(ref)} holds no value it can read`
    )
  }
  if (type === "n") return Number(text)
  if (type === "str") return yield* decodeXml(text)
  if (type === "inlineStr") return yield* stringText(text)
  const shared = strings[Number(text)]
  if (shared === undefined)
    return yield* unreadable(
      `A cell names no shared string: ${yield* excerpt(attributes)}`
    )
  return shared
})

// A row's cells with a value.
// Decision: only cells with a value are kept, so a row grows with the bytes
// of its values, never with the column a cell names: dense rows held 1,200
// XFD cells as 19.6 million slots.
const rowCells = Effect.fnUntraced(function* (
  rowNumber: string,
  inner: string,
  strings: ReadonlyArray<string>
) {
  const cells = new Map<number, Cell>()
  for (const cell of elements(inner, "c")) {
    if (cell === null) return yield* neverClosed("c")
    const [, ref, letters = ""] = REF.exec(cell.attributes) ?? []
    if (ref === undefined)
      return yield* unreadable(`A cell in row ${rowNumber} has no reference`)
    const column = columnIndex(letters)
    if (column > LAST_COLUMN.index)
      return yield* unreadable(
        `Cell ${yield* excerpt(ref)} is past column ${LAST_COLUMN.letters}`
      )
    if (cell.content === undefined) continue
    const value = yield* cellValue(ref, cell.attributes, cell.content, strings)
    if (value !== undefined) cells.set(column, value)
  }
  return cells as Row
})

// Calls `onRow` with each of the first worksheet's rows with a value, in
// the sheet's order, by its 1-based row number.
// Decision: a row at a time, kept by nothing here, so a parse keeps only
// what it takes from each row: a report padded to the largest sheet held
// its every row and the month's holdings at once.
export const forEachRow = Effect.fnUntraced(function* <E, R>(
  bytes: Uint8Array,
  onRow: (rowNumber: number, cells: Row) => Effect.Effect<void, E, R>
) {
  const { strings, sheet } = yield* Effect.gen(function* () {
    const entries = yield* zipEntries(bytes)
    return {
      strings: yield* sharedStrings(
        yield* entryText(
          bytes,
          entries,
          SHARED_STRINGS,
          MAX_SHARED_STRINGS_BYTES
        )
      ),
      sheet: yield* entryText(bytes, entries, SHEET),
    }
  }).pipe(
    Effect.catchTag("ZipUnreadable", ({ message }) =>
      Effect.fail(unreadable(message))
    )
  )
  for (const row of elements(sheet, "row")) {
    if (row === null) return yield* neverClosed("row")
    if (row.content === undefined) continue
    const rowNumber = ROW_NUMBER.exec(row.attributes)?.[1]
    if (rowNumber === undefined) return yield* unreadable("A row has no number")
    const cells = yield* rowCells(rowNumber, row.content, strings)
    if (cells.size > 0) yield* onRow(Number(rowNumber), cells)
  }
})
