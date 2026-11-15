import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_REPORT_BYTES } from "@/server/shareholding/archive-run"
import { MAX_SHARED_STRINGS_BYTES } from "@/server/holdings/xlsx"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { atCap, bytesOf, longNamedFiles } from "./at-cap.ts"
import { PARSE_HEAP_MIB, parseInBoundedHeap } from "./bounded-heap.ts"
import {
  columnLetters,
  SHARED_STRINGS,
  SHEET,
  sharedItems,
  SPLIT_HEADER_ROW,
  SPLIT_LABELS,
} from "./workbook.ts"
import { zipOf } from "./zip-of.ts"

const XFD = 16_383

// Row `row`: stock S<row>, holding a share in every column.
const stockRow = (row: number) => {
  const cells = [`<c r="B${row}" t="str"><v>S${row}</v></c>`]
  for (let column = 3; column < SPLIT_LABELS.length - 1; column++)
    cells.push(`<c r="${columnLetters(column)}${row}"><v>1</v></c>`)
  cells.push(
    `<c r="${columnLetters(SPLIT_LABELS.length - 1)}${row}"><v>${SPLIT_LABELS.length - 4}</v></c>`
  )
  return `<row r="${row}">${cells.join("")}</row>`
}

// Row `row`, one cell in A holding 0: a row's shortest XML with a value.
const shortRow = (row: number) =>
  `<row r="${row}"><c r="A${row}"><v>0</v></c></row>`

// Row `row`, a cell in each of `columns` holding `cell`'s XML for the column.
const rowOf = (row: number, columns: number, cell: (ref: string) => string) => {
  const cells: Array<string> = []
  for (let column = 0; column < columns; column++)
    cells.push(cell(`${columnLetters(column)}${row}`))
  return `<row r="${row}">${cells.join("")}</row>`
}

const SHEET_HEAD = "<worksheet><sheetData>"
const SHEET_TAIL = "</sheetData></worksheet>"
const sheet = (rows: string) => bytesOf(SHEET_HEAD, rows, SHEET_TAIL)

const LABELS = `<sst>${sharedItems(SPLIT_LABELS)}`

// `atCap` at the shared strings' cap.
const sharedAtCap = (...[head, unit, tail]: Parameters<typeof atCap>) =>
  atCap(head, unit, tail, MAX_SHARED_STRINGS_BYTES)
const labelsOnly = bytesOf(LABELS, "</sst>")

// The shared string after SPLIT_LABELS, of `A`s to the shared strings' cap.
const LONG = SPLIT_LABELS.length
const longString = sharedAtCap(`${LABELS}<si><t>`, "A", "</t></si></sst>")

// The header row and one stock.
const ONE_STOCK = SPLIT_HEADER_ROW + stockRow(2)

// SPLIT_LABELS, then distinct strings until the shared strings reach their
// cap.
const paddedStrings = () => {
  const strings = [...SPLIT_LABELS]
  const entryBytes = (string: string) => `<si><t>${string}</t></si>`.length
  let size =
    "<sst></sst>".length +
    strings.reduce((sum, string) => sum + entryBytes(string), 0)
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

// The largest sheet: the header row, then `stocks` stock rows, or as many
// as fit, then as many `shortRow`s as fit.
const largestSheet = (stocks: number) => {
  const rows = [SPLIT_HEADER_ROW]
  let size = SHEET_HEAD.length + SHEET_TAIL.length + SPLIT_HEADER_ROW.length
  let row = 2
  for (; row <= stocks + 1; row++) {
    if (size + stockRow(row).length > MAX_ENTRY_BYTES) break
    rows.push(stockRow(row))
    size += stockRow(row).length
  }
  for (; size + shortRow(row).length <= MAX_ENTRY_BYTES; row++) {
    rows.push(shortRow(row))
    size += shortRow(row).length
  }
  return sheet(rows.join(""))
}

// Row 9, a cell in each column from A holding 0, as many as fit.
const cellsPastXfd = () => {
  const cells: Array<string> = []
  let size = SHEET_HEAD.length + ONE_STOCK.length + '<row r="9"></row>'.length
  for (let column = 0; ; column++) {
    const cell = `<c r="${columnLetters(column)}9"><v>0</v></c>`
    if (size + cell.length + SHEET_TAIL.length > MAX_ENTRY_BYTES) break
    cells.push(cell)
    size += cell.length
  }
  return sheet(`${ONE_STOCK}<row r="9">${cells.join("")}</row>`)
}

// Each shape with its parts at their caps, and what parsing it in
// PARSE_HEAP_MIB posts.
const SHAPES: ReadonlyArray<{
  readonly shape: string
  readonly report: () => Effect.Effect<Uint8Array>
  readonly posts: string
}> = [
  {
    shape: "more stocks than a month can list",
    report: () =>
      zipOf([
        [SHARED_STRINGS, paddedStrings()],
        [SHEET, largestSheet(Number.POSITIVE_INFINITY)],
      ]),
    posts: "The report lists more than 2,000 stocks",
  },
  {
    shape:
      "the most stocks a month can list, each holding in every column, padded with value rows and shared strings",
    report: () =>
      zipOf([
        [SHARED_STRINGS, paddedStrings()],
        [SHEET, largestSheet(2_000)],
      ]),
    posts: "Parsed 2000 stocks",
  },
  {
    shape: "one shared string of empty rich-text runs",
    report: () =>
      zipOf([
        [
          SHARED_STRINGS,
          sharedAtCap(`${LABELS}<si>`, "<r><t></t></r>", "</si></sst>"),
        ],
        [SHEET, sheet(ONE_STOCK)],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "one shared string of one-letter rich-text runs",
    report: () =>
      zipOf([
        [
          SHARED_STRINGS,
          sharedAtCap(`${LABELS}<si>`, "<r><t>a</t></r>", "</si></sst>"),
        ],
        [SHEET, sheet(ONE_STOCK)],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "empty shared strings",
    report: () =>
      zipOf([
        [SHARED_STRINGS, sharedAtCap(LABELS, "<si></si>", "</sst>")],
        [SHEET, sheet(ONE_STOCK)],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "empty shared strings past their cap",
    report: () =>
      zipOf([
        [SHARED_STRINGS, atCap(LABELS, "<si></si>", "</sst>")],
        [SHEET, sheet(ONE_STOCK)],
      ]),
    posts: `xl/sharedStrings.xml inflates past ${MAX_SHARED_STRINGS_BYTES} bytes`,
  },
  {
    shape: "shared strings of one two-byte character",
    report: () =>
      zipOf([
        [
          SHARED_STRINGS,
          sharedAtCap(LABELS, bytesOf("<si><t>", 0xff, "</t></si>"), "</sst>"),
        ],
        [SHEET, sheet(ONE_STOCK)],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "a shared string and a cell of two-byte characters",
    report: () =>
      zipOf([
        [
          SHARED_STRINGS,
          sharedAtCap(`${LABELS}<si><t>`, 0xff, "</t></si></sst>"),
        ],
        [
          SHEET,
          atCap(
            `${SHEET_HEAD}${ONE_STOCK}<row r="9"><c r="A9" t="str"><v>`,
            0xff,
            `</v></c></row>${SHEET_TAIL}`
          ),
        ],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "rows holding a value in every column, above the header row",
    report: () =>
      zipOf([
        [SHARED_STRINGS, labelsOnly],
        [
          SHEET,
          atCap(
            SHEET_HEAD,
            rowOf(1, XFD + 1, (ref) => `<c r="${ref}"><v>0</v></c>`),
            ONE_STOCK + SHEET_TAIL
          ),
        ],
      ]),
    posts: "Parsed 1 stocks",
  },
  {
    shape: "a row of cells past column XFD",
    report: () =>
      zipOf([
        [SHARED_STRINGS, labelsOnly],
        [SHEET, cellsPastXfd()],
      ]),
    posts: "Cell XFE9 is past column XFD",
  },
  {
    shape: "rows never closed",
    report: () =>
      zipOf([
        [SHARED_STRINGS, labelsOnly],
        [SHEET, atCap(SHEET_HEAD + ONE_STOCK, '<row r="9">', SHEET_TAIL)],
      ]),
    posts: "A <row> is never closed",
  },
  {
    shape: "a row of cells never closed",
    report: () =>
      zipOf([
        [SHARED_STRINGS, labelsOnly],
        [
          SHEET,
          atCap(
            `${SHEET_HEAD}${ONE_STOCK}<row r="9">`,
            '<c r="A9">',
            `</row>${SHEET_TAIL}`
          ),
        ],
      ]),
    posts: "A <c> is never closed",
  },
  {
    shape: "the longest shared string as every stock's code",
    report: () =>
      zipOf([
        [SHARED_STRINGS, longString],
        [
          SHEET,
          sheet(
            SPLIT_HEADER_ROW +
              Array.from(
                { length: 2_000 },
                (_, index) =>
                  `<row r="${index + 2}"><c r="B${index + 2}" t="s"><v>${LONG}</v></c></row>`
              ).join("")
          ),
        ],
      ]),
    posts: `Row 2's SHARE CODE is over 16 characters: ${"A".repeat(40)}…`,
  },
  {
    shape: "the longest shared string as every stock's issuer name",
    report: () =>
      zipOf([
        [SHARED_STRINGS, longString],
        [
          SHEET,
          sheet(
            SPLIT_HEADER_ROW +
              Array.from({ length: 2_000 }, (_, index) => {
                const row = index + 2
                return `<row r="${row}"><c r="B${row}" t="str"><v>S${row}</v></c><c r="C${row}" t="s"><v>${LONG}</v></c></row>`
              }).join("")
          ),
        ],
      ]),
    posts: "S2 (row 2)'s ISSUER NAME is over 256 characters",
  },
  {
    shape: "rows naming the longest shared string in every column",
    report: () =>
      zipOf([
        [SHARED_STRINGS, longString],
        [
          SHEET,
          atCap(
            SHEET_HEAD,
            rowOf(
              1,
              XFD + 1,
              (ref) => `<c r="${ref}" t="s"><v>${LONG}</v></c>`
            ),
            SHEET_TAIL
          ),
        ],
      ]),
    posts: "No header row names SHARE CODE",
  },
  {
    shape: "a zip of as many files under the longest names as IDX's file holds",
    report: () =>
      zipOf([
        [SHARED_STRINGS, labelsOnly],
        [SHEET, sheet(ONE_STOCK)],
        ...longNamedFiles(MAX_REPORT_BYTES),
      ]),
    posts: "The zip's directory is over 65,536 bytes",
  },
]

describe(`the largest classification report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  for (const { shape, report, posts } of SHAPES)
    it.effect(
      shape,
      () =>
        Effect.gen(function* () {
          assert.strictEqual(
            yield* parseInBoundedHeap("classification", yield* report()),
            posts
          )
        }),
      { timeout: 30_000 }
    )
})
