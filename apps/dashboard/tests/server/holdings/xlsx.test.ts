import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  CellError,
  forEachRow,
  type ReadCell,
  refuseErrors,
} from "@/server/holdings/xlsx"

import { workbook } from "./workbook.ts"

const XFD = 16_383

// Every row `forEachRow` reads from `rows`, in order.
const read = Effect.fnUntraced(function* (xml: string) {
  const rows: Array<[number, ReadonlyMap<number, ReadCell>]> = []
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

  it.effect("refuses a row with no number", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        read('<row><c r="A1"><v>7</v></c></row>')
      )
      assert.strictEqual(error.message, "A row has no number")
    })
  )
})

describe("a cell's type", () => {
  // A1 holding `cell`'s XML, typed `type`.
  const cellOf = (type: string, content: string) =>
    `<row r="1"><c r="A1" ${type}>${content}</c></row>`

  for (const [type, content, value] of [
    ['t="inlineStr"', "<is><t>BBCA</t></is>", "BBCA"],
    [
      't="inlineStr"',
      '<is><r><rPr><b/></rPr><t>BB</t></r><r><t xml:space="preserve">CA &amp; </t></r></is>',
      "BBCA & ",
    ],
    ['t="str"', "<v>BBCA</v>", "BBCA"],
    ['t="n"', "<v>7</v>", 7],
    ["", "<v>7</v>", 7],
    // Excel's text of a boolean: IDX's Apr 2026 investor-type report writes
    // the stock code TRUE as one.
    ['t="b"', "<v>1</v>", "TRUE"],
    ['t="b"', "<v>0</v>", "FALSE"],
  ] as const)
    it.effect(`reads ${type || "no type"} as ${JSON.stringify(value)}`, () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* read(cellOf(type, content)), [
          [1, new Map([[0, value]])],
        ])
      })
    )

  it.effect("refuses a boolean neither 0 nor 1", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read(cellOf('t="b"', "<v>2</v>")))
      assert.strictEqual(error.message, "Cell A1's boolean isn't 0 or 1: 2")
    })
  )

  it.effect("reads an error as an error, never as its text", () =>
    Effect.gen(function* () {
      const [[, cells] = [0, new Map()]] = yield* read(
        cellOf('t="e"', "<v>#DIV/0!</v>")
      )
      const cell = cells.get(0)
      assert.instanceOf(cell, CellError)
      assert.strictEqual(cell.text, "#DIV/0!")
    })
  )

  it.effect("refuses an error in a row read without errors", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        forEachRow(
          yield* workbook(
            `<row r="7"><c r="A7"><v>1</v></c><c r="AB7" t="e"><v>#N/A</v></c></row>`
          ),
          refuseErrors
        )
      )
      assert.deepStrictEqual(
        [error._tag, error.message],
        ["XlsxUnreadable", "Cell AB7 holds the error #N/A"]
      )
    })
  )

  for (const type of ["d", "x"])
    it.effect(`refuses t="${type}"`, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          read(cellOf(`t="${type}"`, "<v>1</v>"))
        )
        assert.strictEqual(
          error.message,
          `Cell A1's type is "${type}": a cell is read only as a shared string, a string, an inline string, a number, a boolean or an error`
        )
      })
    )

  it.effect("refuses an inline string never closed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        read(cellOf('t="inlineStr"', "<is><t>BBCA</t>"))
      )
      assert.strictEqual(error.message, "A <is> is never closed")
    })
  )

  it.effect("refuses a cell that holds something but no value", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read(cellOf("", "<f>1+1</f>")))
      assert.strictEqual(error.message, "Cell A1 holds no value it can read")
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
