import { describe, expect, test } from "vitest"

import {
  MINUS,
  asOf,
  billionShort,
  compact,
  compactIdr,
  dateTime,
  direction,
  idr,
  pct,
  plain,
  shares,
  signed,
} from "@/lib/format"

describe("en-US number formatting", () => {
  test("idr groups thousands with a comma and drops the sign", () => {
    expect(idr(9275)).toBe("Rp9,275")
    expect(idr(-9275)).toBe("Rp9,275")
  })

  test("plain uses a dot decimal separator", () => {
    expect(plain(1234)).toBe("1,234")
    expect(plain(7243.18, 2)).toBe("7,243.18")
    expect(plain(7243.18, 1)).toBe("7,243.2")
  })

  test("pct always shows two decimals and a typographic minus", () => {
    expect(pct(1.35)).toBe("+1.35%")
    expect(pct(-1.35)).toBe(`${MINUS}1.35%`)
    expect(pct(0)).toBe("0.00%")
  })

  test("signed prefixes a sign and omits it for zero", () => {
    expect(signed(90)).toBe("+90")
    expect(signed(-1.5, 1)).toBe(`${MINUS}1.5`)
    expect(signed(0)).toBe("0")
  })

  test("direction classifies the sign", () => {
    expect(direction(3)).toBe("up")
    expect(direction(-3)).toBe("down")
    expect(direction(0)).toBe("flat")
  })
})

describe("K, M and B suffixes", () => {
  test("compact picks the suffix by magnitude, up to two decimals", () => {
    expect(compact(1.234e9)).toBe("1.23 B")
    expect(compact(12.4e6)).toBe("12.4 M")
    expect(compact(3500)).toBe("3.5 K")
    expect(compact(950)).toBe("950")
    expect(compact(-2e6)).toBe("2 M")
  })

  test("B is the largest suffix", () => {
    expect(compact(2.5e12)).toBe("2,500 B")
  })

  test("compactIdr signs a rupiah figure", () => {
    expect(compactIdr(1.23e9)).toBe("+Rp1.23 B")
    expect(compactIdr(-128.6e9)).toBe(`${MINUS}Rp128.6 B`)
    expect(compactIdr(4.2e6)).toBe("+Rp4.2 M")
    expect(compactIdr(950)).toBe("+Rp950")
    expect(compactIdr(0)).toBe("Rp0")
  })

  test("the big-trade line reads Rp1 B", () => {
    expect(compactIdr(1e9)).toBe("+Rp1 B")
  })

  test("billionShort fixes the unit at B", () => {
    expect(billionShort(318e9)).toBe("+Rp318 B")
    expect(billionShort(-1.5e9)).toBe(`${MINUS}Rp2 B`)
  })

  test("shares picks the suffix by magnitude", () => {
    expect(shares(1.2e9)).toBe("1.2 B shares")
    expect(shares(12.4e6)).toBe("12.4 M shares")
    expect(shares(3500)).toBe("3.5 K shares")
    expect(shares(42)).toBe("42 shares")
  })
})

describe("WIB timestamps", () => {
  test("asOf renders 24-hour Jakarta time", () => {
    expect(asOf("2026-10-24T07:45:00Z")).toBe("14:45 WIB")
    expect(asOf("2026-10-24T17:05:00Z")).toBe("00:05 WIB")
  })

  test("dateTime includes the short month and day", () => {
    // ICU versions differ on the comma after the day.
    expect(dateTime("2026-10-24T07:45:00Z")).toMatch(/^Oct 24,? 14:45 WIB$/)
  })
})
