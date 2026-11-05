import { describe, expect, test } from "vitest"

import { compactIdr } from "@/lib/format"
import { flowReadoutRow } from "@/components/k/charts/net-flow-chart"

describe("flowReadoutRow", () => {
  test("a positive net reads as a net buy in the up color", () => {
    expect(flowReadoutRow({ label: "BBCA", net: 86.2e9 }, compactIdr)).toEqual({
      label: "Net beli",
      value: "+Rp86,2 miliar",
      swatch: "var(--semantic-up)",
    })
  })

  test("a negative net reads as a net sell in the down color", () => {
    expect(flowReadoutRow({ label: "YP", net: -4e6 }, compactIdr)).toEqual({
      label: "Net jual",
      value: "−Rp4,0 juta",
      swatch: "var(--semantic-down)",
    })
  })

  test("a flat session counts as a net buy", () => {
    expect(flowReadoutRow({ label: "14 Okt", net: 0 }, String).label).toBe(
      "Net beli"
    )
  })
})
