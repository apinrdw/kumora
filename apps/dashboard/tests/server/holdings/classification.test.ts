import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseClassificationMonth } from "@/server/holdings/classification"
import { HoldingsDb } from "@/server/holdings/db"
import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { retainedHeap } from "../../support/retained-heap.ts"
import {
  columnLetters,
  SPLIT_HEADER_ROW,
  SPLIT_LABELS,
  WORKSHEET_BYTES,
  workbook,
} from "./workbook.ts"

// Decision: a parsed month keeps at most 48 MiB on the heap when it is
// written, so the Worker's 128 MiB still holds the archived file and the
// run around it.
const WRITE_HEAP_LIMIT = 48 * 2 ** 20

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

// The header row, then `stocks` stock rows, or as many as fit the largest
// sheet a zip entry inflates to.
const report = (stocks: number) => {
  const rows = [SPLIT_HEADER_ROW]
  let size = WORKSHEET_BYTES + SPLIT_HEADER_ROW.length
  for (let row = 2; row <= stocks + 1; row++) {
    if (size + stockRow(row).length > MAX_ENTRY_BYTES) break
    rows.push(stockRow(row))
    size += stockRow(row).length
  }
  return workbook(rows.join(""), SPLIT_LABELS)
}

// Parses `bytes`, with the heap retained when the month is written.
const parse = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const before = yield* retainedHeap
  let atWrite = 0
  const parsed = yield* parseClassificationMonth(
    "2026-10-30",
    "sha",
    bytes,
    "2026-11-15T00:00:00Z"
  ).pipe(
    Effect.provideService(HoldingsDb, {
      batch: () =>
        Effect.map(retainedHeap, (heap) => {
          atWrite = heap - before
          return []
        }),
    })
  )
  return { parsed, atWrite }
})

describe("the largest classification report", () => {
  it.effect(
    "is refused once it lists more stocks than a month can",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          parse(yield* report(Number.POSITIVE_INFINITY))
        )
        assert.strictEqual(
          error.message,
          "The report lists more than 2,000 stocks"
        )
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "keeps under 48 MiB at the most stocks a month can list, each holding in every column",
    () =>
      Effect.gen(function* () {
        const { parsed, atWrite } = yield* parse(yield* report(2_000))
        assert.strictEqual(parsed, 2_000)
        assert.isBelow(
          atWrite,
          WRITE_HEAP_LIMIT,
          `${(atWrite / 2 ** 20).toFixed(0)} MiB retained`
        )
      }),
    { timeout: 30_000 }
  )
})
