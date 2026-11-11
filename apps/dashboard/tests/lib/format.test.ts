import { WibDate } from "@workspace/relay"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  MINUS,
  asOf,
  tapeTime,
  billionShort,
  compact,
  compactIdr,
  dateTime,
  dayLabel,
  direction,
  idr,
  pct,
  plain,
  shares,
  signed,
} from "@/lib/format"

describe("en-US number formatting", () => {
  it.effect("idr groups thousands with a comma and drops the sign", () =>
    Effect.gen(function* () {
      expect(yield* idr(9275)).toBe("Rp9,275")
      expect(yield* idr(-9275)).toBe("Rp9,275")
    })
  )

  it.effect("plain uses a dot decimal separator", () =>
    Effect.gen(function* () {
      expect(yield* plain(1234)).toBe("1,234")
      expect(yield* plain(7243.18, 2)).toBe("7,243.18")
      expect(yield* plain(7243.18, 1)).toBe("7,243.2")
    })
  )

  it.effect("pct always shows two decimals and a typographic minus", () =>
    Effect.gen(function* () {
      expect(yield* pct(1.35)).toBe("+1.35%")
      expect(yield* pct(-1.35)).toBe(`${MINUS}1.35%`)
      expect(yield* pct(0)).toBe("0.00%")
    })
  )

  it.effect("signed prefixes a sign and omits it for zero", () =>
    Effect.gen(function* () {
      expect(yield* signed(90)).toBe("+90")
      expect(yield* signed(-1.5, 1)).toBe(`${MINUS}1.5`)
      expect(yield* signed(0)).toBe("0")
    })
  )

  it.effect("direction classifies the sign", () =>
    Effect.gen(function* () {
      expect(yield* direction(3)).toBe("up")
      expect(yield* direction(-3)).toBe("down")
      expect(yield* direction(0)).toBe("flat")
    })
  )
})

describe("K, M and B suffixes", () => {
  it.effect("compact picks the suffix by magnitude, up to two decimals", () =>
    Effect.gen(function* () {
      expect(yield* compact(1.234e9)).toBe("1.23 B")
      expect(yield* compact(12.4e6)).toBe("12.4 M")
      expect(yield* compact(3500)).toBe("3.5 K")
      expect(yield* compact(950)).toBe("950")
      expect(yield* compact(-2e6)).toBe("2 M")
    })
  )

  it.effect("B is the largest suffix", () =>
    Effect.gen(function* () {
      expect(yield* compact(2.5e12)).toBe("2,500 B")
    })
  )

  it.effect("compactIdr signs a rupiah figure", () =>
    Effect.gen(function* () {
      expect(yield* compactIdr(1.23e9)).toBe("+Rp1.23 B")
      expect(yield* compactIdr(-128.6e9)).toBe(`${MINUS}Rp128.6 B`)
      expect(yield* compactIdr(4.2e6)).toBe("+Rp4.2 M")
      expect(yield* compactIdr(950)).toBe("+Rp950")
      expect(yield* compactIdr(0)).toBe("Rp0")
    })
  )

  it.effect("the big-trade line reads Rp1 B", () =>
    Effect.gen(function* () {
      expect(yield* compactIdr(1e9)).toBe("+Rp1 B")
    })
  )

  it.effect("billionShort fixes the unit at B", () =>
    Effect.gen(function* () {
      expect(yield* billionShort(318e9)).toBe("+Rp318 B")
      expect(yield* billionShort(-1.5e9)).toBe(`${MINUS}Rp2 B`)
    })
  )

  it.effect("shares picks the suffix by magnitude", () =>
    Effect.gen(function* () {
      expect(yield* shares(1.2e9)).toBe("1.2 B shares")
      expect(yield* shares(12.4e6)).toBe("12.4 M shares")
      expect(yield* shares(3500)).toBe("3.5 K shares")
      expect(yield* shares(42)).toBe("42 shares")
    })
  )
})

describe("WIB timestamps", () => {
  it.effect("tapeTime renders Jakarta time to the second, midnight as 00", () =>
    Effect.gen(function* () {
      expect(yield* tapeTime(Date.parse("2026-11-09T02:00:07Z"))).toBe(
        "09:00:07"
      )
      expect(yield* tapeTime(Date.parse("2026-11-09T17:00:05Z"))).toBe(
        "00:00:05"
      )
    })
  )

  it.effect("asOf renders 24-hour Jakarta time", () =>
    Effect.gen(function* () {
      expect(yield* asOf("2026-10-24T07:45:00Z")).toBe("14:45 WIB")
      expect(yield* asOf("2026-10-24T17:05:00Z")).toBe("00:05 WIB")
    })
  )

  it.effect("dayLabel names a WIB date's weekday, month and day", () =>
    Effect.gen(function* () {
      expect(yield* dayLabel(WibDate.make("2026-11-06"))).toBe("Fri, Nov 6")
      expect(yield* dayLabel(WibDate.make("2027-01-04"))).toBe("Mon, Jan 4")
    })
  )

  it.effect("dateTime includes the short month and day", () =>
    Effect.gen(function* () {
      // ICU versions differ on the comma after the day.
      expect(yield* dateTime("2026-10-24T07:45:00Z")).toMatch(
        /^Oct 24,? 14:45 WIB$/
      )
    })
  )
})
