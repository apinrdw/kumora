import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { readSheet } from "@/server/holdings/xlsx"

import { zipOf } from "./zip-of.ts"

// Decision: a read sheet keeps at most 48 MiB on the heap, so the Worker's
// 128 MiB still holds the archived file, its inflated XML and the parsed
// holdings.
const SHEET_HEAP_LIMIT = 48 * 2 ** 20

// The heap after a full collection: what is retained, not what is garbage.
const retainedHeap = Effect.sync(() => {
  setFlagsFromString("--expose-gc")
  const collect = runInNewContext("gc") as () => void
  collect()
  return process.memoryUsage().heapUsed
})

const text = (xml: string) => new TextEncoder().encode(xml)

// An .xlsx whose first worksheet holds `rows`, with no shared strings.
const workbook = (rows: string) =>
  zipOf([
    ["xl/sharedStrings.xml", text("<sst></sst>")],
    [
      "xl/worksheets/sheet1.xml",
      text(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
    ],
  ])

// Rows 1 to `count`, each one numbered cell in XFD, the last column.
const farCells = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `<row r="${index + 1}"><c r="XFD${index + 1}"><v>${index + 1}</v></c></row>`
  ).join("")

describe("a worksheet", () => {
  it.effect("keeps a far column's cells without the columns before them", () =>
    Effect.gen(function* () {
      const bytes = yield* workbook(farCells(1_200))
      const before = yield* retainedHeap
      const rows = yield* readSheet(bytes)
      const retained = (yield* retainedHeap) - before
      assert.strictEqual(rows.size, 1_200)
      assert.isBelow(
        retained,
        SHEET_HEAP_LIMIT,
        `${(retained / 2 ** 20).toFixed(0)} MiB retained`
      )
    })
  )
})
