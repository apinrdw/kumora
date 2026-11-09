import { describe, expect, it } from "vitest"

import { parseMarketLiveSearch } from "@/lib/market-live-search"

describe("the Market Live search params", () => {
  it("keeps a listed code's shape, warrants included", () => {
    expect(parseMarketLiveSearch({ code: "BBRI" })).toEqual({ code: "BBRI" })
    expect(parseMarketLiveSearch({ code: "AMAG-W2" })).toEqual({
      code: "AMAG-W2",
    })
  })

  it("drops a code that isn't one, so the page falls back", () => {
    for (const code of ["not a code", "bbri", "", 42, "TOOLONGCODE123"])
      expect(parseMarketLiveSearch({ code })).toStrictEqual({ code: undefined })
    expect(parseMarketLiveSearch({})).toStrictEqual({ code: undefined })
  })
})
