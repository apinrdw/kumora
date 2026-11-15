import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { PARSE_HEAP_MIB, parseInBoundedHeap } from "./bounded-heap.ts"
import {
  columnLetters,
  SPLIT_HEADER_ROW,
  SPLIT_LABELS,
  WORKSHEET_BYTES,
  workbook,
} from "./workbook.ts"

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

// SPLIT_LABELS, then distinct strings until the shared strings are the
// largest a zip entry inflates to.
const paddedStrings = () => {
  const strings = [...SPLIT_LABELS]
  const entryBytes = (string: string) => `<si><t>${string}</t></si>`.length
  let size =
    "<sst></sst>".length +
    strings.reduce((sum, string) => sum + entryBytes(string), 0)
  for (
    let index = 0;
    size + entryBytes(`S${index}`) <= MAX_ENTRY_BYTES;
    index++
  ) {
    strings.push(`S${index}`)
    size += entryBytes(`S${index}`)
  }
  return strings
}

// The largest sheet and shared strings a zip entry inflates to: the header
// row, then `stocks` stock rows, or as many as fit, then as many `shortRow`s
// as fit.
const report = (stocks: number) => {
  const rows = [SPLIT_HEADER_ROW]
  let size = WORKSHEET_BYTES + SPLIT_HEADER_ROW.length
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
  return workbook(rows.join(""), paddedStrings())
}

describe(`the largest classification report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  it.effect(
    "is refused once it lists more stocks than a month can",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* parseInBoundedHeap(
            "classification",
            yield* report(Number.POSITIVE_INFINITY)
          ),
          "The report lists more than 2,000 stocks"
        )
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "parses the most stocks a month can list, each holding in every column, padded with value rows and shared strings",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* parseInBoundedHeap("classification", yield* report(2_000)),
          "Parsed 2000 stocks"
        )
      }),
    { timeout: 30_000 }
  )
})
