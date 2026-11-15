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

describe("a cell's character references", () => {
  // A text cell in A1 holding `text`.
  const textCell = (text: string) =>
    `<row r="1"><c r="A1" t="str"><v>${text}</v></c></row>`

  for (const [reference, refused] of [
    ["&#x110000;", "&#x110000;"],
    ["&#1114112;", "&#1114112;"],
    ["&#xD800;", "&#xD800;"],
    [`&#${"9".repeat(400)};`, `&#${"9".repeat(38)}…`],
  ])
    it.effect(`refuses ${refused}, which names no character`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(read(textCell(reference)))
        assert.deepStrictEqual(
          [error._tag, error.message],
          ["XlsxUnreadable", `${refused} names no character`]
        )
      })
    )

  it.effect("keeps &#; as text, since it is no reference", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* read(textCell("&#;&#x10FFFF;")), [
        [1, new Map([[0, `&#;${String.fromCodePoint(0x10ffff)}`]])],
      ])
    })
  )
})
