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

// Oct 2026's layout, A to M.
const LABELS = [
  "DATE",
  "SHARE_CODE",
  "ISSUER_NAME",
  "INVESTOR_NAME",
  "INVESTOR_CLASSIFICATION",
  "CONTROLLER_OR_AFFILIATE",
  "LOCAL_FOREIGN",
  "NATIONALITY",
  "DOMICILE",
  "HOLDINGS_SCRIPLESS",
  "HOLDINGS_SCRIP",
  "TOTAL_HOLDING_SHARES",
  "PERCENTAGE",
]

const inline = (ref: string, text: string) =>
  `<c r="${ref}" t="str"><v>${text}</v></c>`

const HEADER = `<row r="1">${LABELS.map((label, column) =>
  inline(`${columnLetters(column)}1`, label)
).join("")}</row>`

// The longest INVESTOR_NAME, of 2-letter words so its holder key is as long,
// is shared string 0; the longest other text is 1; the stock code is 2.
const STRINGS = ["AB ".repeat(85).concat("A"), "A".repeat(128), "AAAA"]

const shared = (ref: string, index: number) =>
  `<c r="${ref}" t="s"><v>${index}</v></c>`
const number = (ref: string, value: number) =>
  `<c r="${ref}"><v>${value}</v></c>`

// Row `row`: a holder of stock AAAA with every text cell at its longest.
const fullRow = (row: number) =>
  `<row r="${row}">${[
    shared(`B${row}`, 2),
    shared(`C${row}`, 1),
    shared(`D${row}`, 0),
    inline(`E${row}`, "Corporate"),
    inline(`F${row}`, "CONTROLLER"),
    inline(`G${row}`, "L"),
    shared(`H${row}`, 1),
    shared(`I${row}`, 1),
    number(`J${row}`, 1),
    number(`K${row}`, 1),
    number(`L${row}`, 2),
    number(`M${row}`, 1.5),
  ].join("")}</row>`

// Row `row`: a holder in the fewest cells a holder takes.
const shortRow = (row: number) =>
  `<row r="${row}">${[
    shared(`B${row}`, 2),
    shared(`C${row}`, 2),
    shared(`D${row}`, 2),
    number(`M${row}`, 1),
  ].join("")}</row>`

// Row `row`, an error alone, which holds no holder.
const errorRow = (row: number) =>
  `<row r="${row}"><c r="A${row}" t="e"><v>#N/A</v></c></row>`

const SHEET_HEAD = "<worksheet><sheetData>"
const SHEET_TAIL = "</sheetData></worksheet>"

// The largest sheet: the header row, then `holders` rows of `holderRow`, or
// as many as fit, then as many error rows as fit.
const largestSheet = (holders: number, holderRow: (row: number) => string) => {
  const rows = [HEADER]
  let size = SHEET_HEAD.length + SHEET_TAIL.length + HEADER.length
  let row = 2
  for (; row <= holders + 1; row++) {
    if (size + holderRow(row).length > MAX_ENTRY_BYTES) break
    rows.push(holderRow(row))
    size += holderRow(row).length
  }
  for (; size + errorRow(row).length <= MAX_ENTRY_BYTES; row++) {
    rows.push(errorRow(row))
    size += errorRow(row).length
  }
  return bytesOf(SHEET_HEAD, rows.join(""), SHEET_TAIL)
}

// STRINGS, then distinct strings until the shared strings reach their cap.
const paddedStrings = () => {
  const strings = [...STRINGS]
  const entryBytes = (string: string) => `<si><t>${string}</t></si>`.length
  let size =
    "<sst></sst>".length + STRINGS.map(entryBytes).reduce((a, b) => a + b)
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
  readonly holders: number
  readonly holderRow: (row: number) => string
  readonly posts: string
}> = [
  {
    shape: "more holders than a month can list",
    holders: Number.POSITIVE_INFINITY,
    holderRow: shortRow,
    posts: "The report lists more than 15,000 holders",
  },
  {
    shape:
      "the most holders a month can list, each with its every text at its longest, padded with error rows and shared strings",
    holders: 15_000,
    holderRow: fullRow,
    posts: "Parsed 1 stocks",
  },
]

describe(`the largest above-1% report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  for (const { shape, holders, holderRow, posts } of SHAPES)
    it.effect(
      shape,
      () =>
        Effect.gen(function* () {
          const report = yield* zipOf([
            [SHARED_STRINGS, paddedStrings()],
            [SHEET, largestSheet(holders, holderRow)],
          ])
          assert.strictEqual(
            yield* parseInBoundedHeap("above-1", report),
            posts
          )
        }),
      { timeout: 30_000 }
    )
})
