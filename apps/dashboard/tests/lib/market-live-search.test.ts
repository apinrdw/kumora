import { describe, expect, it } from "vitest"

import { parseMarketLiveSearch } from "@/lib/market-live-search"

describe("the Market Live search params", () => {
  it("keeps a listed code's shape, warrants included", () => {
    expect(parseMarketLiveSearch({ code: "BBRI" })).toMatchObject({
      code: "BBRI",
    })
    expect(parseMarketLiveSearch({ code: "AMAG-W2" })).toMatchObject({
      code: "AMAG-W2",
    })
  })

  it("keeps an index", () => {
    for (const code of ["IHSG", "TN.IHSG", "NG.IHSG"])
      expect(parseMarketLiveSearch({ code }).code).toBe(code)
  })

  it("drops a code that isn't one, so the page falls back", () => {
    for (const code of [
      "not a code",
      "bbri",
      "",
      42,
      "TOOLONGCODE123",
      ".IHSG",
    ])
      expect(parseMarketLiveSearch({ code }).code).toBeUndefined()
    expect(parseMarketLiveSearch({})).toStrictEqual({
      code: undefined,
      day: undefined,
    })
  })

  it("keeps a recorded day's date and drops anything else", () => {
    expect(parseMarketLiveSearch({ day: "2026-11-06" })).toMatchObject({
      day: "2026-11-06",
    })
    for (const day of [
      "2026-11-6",
      "06-11-2026",
      "yesterday",
      20261106,
      "",
      "2026-13-01",
      "2026-02-30",
    ])
      expect(parseMarketLiveSearch({ day }).day).toBeUndefined()
  })
})
