import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { type Cell, forEachRow } from "@/server/holdings/xlsx"

import { workbook } from "./workbook.ts"

const XFD = 16_383

// Every row `forEachRow` reads from `rows`, in order.
const read = Effect.fnUntraced(function* (xml: string) {
  const rows: Array<[number, ReadonlyMap<number, Cell>]> = []
  yield* forEachRow(yield* workbook(xml), (rowNumber, cells) =>
    Effect.sync(() => {
      rows.push([rowNumber, cells])
    })
  )
  return rows
})

describe("a worksheet", () => {
  it.effect("keeps a far column's cell without the columns before it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* read(`<row r="7"><c r="XFD7"><v>7</v></c></row>`),
        [[7, new Map([[XFD, 7]])]]
      )
    })
  )

  it.effect("keeps no row or cell without a value", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* read(
          '<row r="1"><c r="A1"/><c r="B1"><v>7</v></c></row><row r="2"><c r="C2"/></row><row r="3"/>'
        ),
        [[1, new Map([[1, 7]])]]
      )
    })
  )
})
