import { describe, expect, test } from "vitest"

import type { AsOf } from "@/ownership/as-of"
import { checkImport, readChunk } from "@/ownership/csv"

import { fixture } from "../support/ownership"

const AADI = fixture("lima-persen-2026-05-29.csv")
const [HEADER = "", FIRST = ""] = AADI.split("\n")

const rowsOf = (csv: string) => readChunk("lima-persen", csv, 0, Infinity)

describe("readChunk", () => {
  test("types a line's cells by column, keeping leading text whole", () => {
    const rows = rowsOf(AADI)
    expect(rows).toHaveLength(16)
    expect(rows[0]).toMatchObject({
      as_of: "2026-05-29",
      holder_no: 1,
      symbol: "AADI",
      issuer_name: "ADARO ANDALAN INDONESIA Tbk, PT",
      nationality: null,
      shares: 84_301_663,
      combined_shares: 3_200_142_830,
      percent: 41.1,
      change: 0,
    })
  })

  test("takes only the chunk's rows", () => {
    const rows = readChunk("lima-persen", AADI, 2, 4)
    expect(rows.map((row) => row.holder_no)).toEqual(
      rowsOf(AADI)
        .slice(2, 4)
        .map((row) => row.holder_no)
    )
    expect(rows).toHaveLength(2)
  })

  test("zero is not empty", () => {
    const zero = FIRST.replace(/,84301663,3200142830,41\.10,0$/, ",0,,41.10,0")
    expect(rowsOf(`${HEADER}\n${zero}\n`)[0]).toMatchObject({
      shares: 0,
      combined_shares: null,
    })
  })

  test("reads TRUE as a symbol, not a boolean", () => {
    const line = FIRST.replace(",AADI,", ",TRUE,")
    expect(rowsOf(`${HEADER}\n${line}\n`)[0]?.symbol).toBe("TRUE")
  })

  test("reads a doubled quote inside a quoted cell", () => {
    const line = FIRST.replace(
      '"ADARO ANDALAN INDONESIA Tbk, PT"',
      '"ADARO ""ANDALAN"", PT"'
    )
    expect(rowsOf(`${HEADER}\n${line}\n`)[0]?.issuer_name).toBe(
      'ADARO "ANDALAN", PT'
    )
  })

  test("a closing quote may end a CRLF record", () => {
    const line = FIRST.replace(/,0$/, ',"0"')
    expect(rowsOf(`${HEADER}\r\n${line}\r\n`)[0]?.change).toBe(0)
  })

  test("refuses columns other than the dataset's", () => {
    expect(() => rowsOf(`${HEADER},extra\n`)).toThrow("columns differ")
  })

  test("refuses a number written with separators", () => {
    const line = FIRST.replace(
      ",84301663,3200142830,41.10,0",
      ',"84,301,663",3200142830,41.10,0'
    )
    expect(() => rowsOf(`${HEADER}\n${line}\n`)).toThrow(
      "row 1: shares does not parse"
    )
  })

  test("refuses a line with the wrong number of cells", () => {
    expect(() => rowsOf(`${HEADER}\n2026-05-29,short\n`)).toThrow(
      "row 1 has 2 cells"
    )
  })
})

describe("checkImport's reason, when a file has several faults", () => {
  const declared = { asOf: "2026-05-29" as AsOf, rowCount: 1 }
  const check = (csv: string, rowCount = declared.rowCount) =>
    checkImport("lima-persen", csv, { ...declared, rowCount })
  const badFigure = FIRST.replace(",84301663,", ",x,")

  test("a malformed field on a later line outranks a bad row", () => {
    expect(check(`${HEADER}\n${badFigure}\n"open\n`)).toMatchObject({
      reason: expect.stringContaining("malformed"),
    })
  })

  test("a bad row outranks the row count", () => {
    expect(check(`${HEADER}\n${badFigure}\n`, 9)).toMatchObject({
      reason: "row 1: previous_shares does not parse",
    })
  })

  test("the row count outranks a stray as-of", () => {
    const stray = FIRST.replace("2026-05-29", "2026-05-28")
    expect(check(`${HEADER}\n${stray}\n`, 9)).toMatchObject({
      reason: "holds 1 rows, not 9 as declared",
    })
    expect(check(`${HEADER}\n${stray}\n`)).toMatchObject({
      reason: "row 1: as_of differs from 2026-05-29",
    })
  })
})
