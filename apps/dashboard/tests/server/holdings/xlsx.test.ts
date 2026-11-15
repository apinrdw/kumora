import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { readSheet } from "@/server/holdings/xlsx"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { retainedHeap } from "../../support/retained-heap.ts"
import { WORKSHEET_BYTES, workbook } from "./workbook.ts"

// Decision: a read sheet keeps at most 48 MiB on the heap, so the Worker's
// 128 MiB still holds the archived file, its inflated XML and the parsed
// holdings.
const SHEET_HEAP_LIMIT = 48 * 2 ** 20

const XFD = 16_383

// Row `row`, one numbered cell in XFD, the last column.
const farCell = (row: number) =>
  `<row r="${row}"><c r="XFD${row}"><v>${row}</v></c></row>`

// Rows 1 to `count` of `farCell`.
const farCells = (count: number) =>
  Array.from({ length: count }, (_, index) => farCell(index + 1)).join("")

// Row `row`, one cell in A holding 0: a row's shortest XML with a value.
const shortRow = (row: number) =>
  `<row r="${row}"><c r="A${row}"><v>0</v></c></row>`

// As many `shortRow`s as fit the largest sheet a zip entry inflates to: a
// row each with a value is the most a sheet's bytes can make it keep.
const largestSheet = () => {
  const rows: Array<string> = []
  let size = WORKSHEET_BYTES
  for (let row = 1; size + shortRow(row).length <= MAX_ENTRY_BYTES; row++) {
    rows.push(shortRow(row))
    size += shortRow(row).length
  }
  return rows
}

describe("a worksheet", () => {
  it.effect("keeps a far column's cells without the columns before them", () =>
    Effect.gen(function* () {
      const bytes = yield* workbook(farCells(1_200))
      const before = yield* retainedHeap
      const rows = yield* readSheet(bytes)
      const retained = (yield* retainedHeap) - before
      assert.strictEqual(rows.size, 1_200)
      assert.strictEqual(rows.get(1_200)?.get(XFD), 1_200)
      assert.isBelow(
        retained,
        SHEET_HEAP_LIMIT,
        `${(retained / 2 ** 20).toFixed(0)} MiB retained`
      )
    })
  )

  it.effect(
    "keeps under 48 MiB of the largest sheet it accepts, a value a row",
    () =>
      Effect.gen(function* () {
        const sheet = largestSheet()
        const bytes = yield* workbook(sheet.join(""))
        const before = yield* retainedHeap
        const rows = yield* readSheet(bytes)
        const retained = (yield* retainedHeap) - before
        assert.strictEqual(rows.size, sheet.length)
        assert.strictEqual(rows.get(sheet.length)?.get(0), 0)
        assert.isBelow(
          retained,
          SHEET_HEAP_LIMIT,
          `${(retained / 2 ** 20).toFixed(0)} MiB retained`
        )
      }),
    { timeout: 30_000 }
  )

  it.effect("keeps no row or cell without a value", () =>
    Effect.gen(function* () {
      const rows = yield* readSheet(
        yield* workbook(
          '<row r="1"><c r="A1"/><c r="B1"><v>7</v></c></row><row r="2"><c r="C2"/></row><row r="3"/>'
        )
      )
      assert.deepStrictEqual([...rows], [[1, new Map([[1, 7]])]])
    })
  )
})
