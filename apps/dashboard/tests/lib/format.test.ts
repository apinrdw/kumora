import { describe, expect, test } from "vitest"

import {
  MINUS,
  asOf,
  compactIdr,
  dateTime,
  direction,
  idr,
  miliarShort,
  pct,
  plain,
  shares,
  signed,
} from "@/lib/format"

describe("Indonesian number formatting", () => {
  test("idr groups thousands with a dot and drops the sign", () => {
    expect(idr(9275)).toBe("Rp9.275")
    expect(idr(-9275)).toBe("Rp9.275")
  })

  test("plain uses a comma decimal separator", () => {
    expect(plain(9275)).toBe("9.275")
    expect(plain(7243.18, 2)).toBe("7.243,18")
    expect(plain(7243.18, 1)).toBe("7.243,2")
  })

  test("pct always shows two decimals and a typographic minus", () => {
    expect(pct(1.35)).toBe("+1,35%")
    expect(pct(-1.35)).toBe(`${MINUS}1,35%`)
    expect(pct(0)).toBe("0,00%")
  })

  test("signed prefixes a sign and omits it for zero", () => {
    expect(signed(90)).toBe("+90")
    expect(signed(-1.5, 1)).toBe(`${MINUS}1,5`)
    expect(signed(0)).toBe("0")
  })

  test("direction classifies the sign", () => {
    expect(direction(3)).toBe("up")
    expect(direction(-3)).toBe("down")
    expect(direction(0)).toBe("flat")
  })
})

describe("compact rupiah", () => {
  test("picks the unit by magnitude", () => {
    expect(compactIdr(2.5e12)).toBe("+Rp2,5 triliun")
    expect(compactIdr(-128.6e9)).toBe(`${MINUS}Rp128,6 miliar`)
    expect(compactIdr(4.2e6)).toBe("+Rp4,2 juta")
    expect(compactIdr(950)).toBe("+Rp950")
    expect(compactIdr(0)).toBe("Rp0")
  })

  test("miliarShort fixes the unit at miliar", () => {
    expect(miliarShort(318e9)).toBe("+Rp318 M")
    expect(miliarShort(-1.5e9)).toBe(`${MINUS}Rp2 M`)
  })

  test("shares picks the unit by magnitude", () => {
    expect(shares(1.2e9)).toBe("1,2 miliar lembar")
    expect(shares(12.4e6)).toBe("12,4 juta lembar")
    expect(shares(3500)).toBe("3,5 ribu lembar")
    expect(shares(42)).toBe("42 lembar")
  })
})

describe("WIB timestamps", () => {
  test("asOf renders Jakarta time with a dot separator", () => {
    expect(asOf("2026-10-24T07:45:00Z")).toBe("14.45 WIB")
  })

  test("dateTime includes the day and short month", () => {
    // ICU versions differ on the comma after the month.
    expect(dateTime("2026-10-24T07:45:00Z")).toMatch(/^24 Okt,? 14\.45 WIB$/)
  })
})
