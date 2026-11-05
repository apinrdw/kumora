import { describe, expect, test } from "vitest"

import { niceScale } from "@/components/k/charts/scale"

describe("niceScale", () => {
  test("rounds a ragged price range outward to a 1-2-5 step", () => {
    expect(niceScale(9193, 9227)).toEqual({
      domain: [9190, 9230],
      ticks: [9190, 9200, 9210, 9220, 9230],
    })
  })

  test("picks a 2.5 step when it fits the requested tick count", () => {
    expect(niceScale(0, 100).ticks).toEqual([0, 25, 50, 75, 100])
  })

  test("a flat series still gets a domain that contains the value", () => {
    expect(niceScale(500, 500)).toEqual({
      domain: [400, 600],
      ticks: [400, 600],
    })
  })

  test("an all-zero series falls back to a unit span", () => {
    expect(niceScale(0, 0)).toEqual({ domain: [0, 0], ticks: [0] })
  })
})
