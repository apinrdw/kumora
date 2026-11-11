import { describe, expect, test } from "vitest"

import { priceReadoutRows, priceScale } from "@/components/k/charts/price-chart"
import type { PricePoint } from "@/domain/quote"

const session: Array<PricePoint> = [
  { label: "09.00", price: 9200, vwap: 9210, volume: 4_000 },
  { label: "09.15", price: 9250, vwap: 9300, volume: 10_000 },
  { label: "09.30", price: 9225 },
]

describe("priceScale", () => {
  test("price only: the domain is the nice range of the prices", () => {
    const bare = session.map(({ label, price }) => ({ label, price }))
    expect(priceScale(bare, true, true)).toEqual({
      hasVwap: false,
      hasVolume: false,
      maxVolume: 0,
      domain: [9200, 9260],
      ticks: [9200, 9220, 9240, 9260],
    })
  })

  test("VWAP widens the price range when it is shown", () => {
    expect(priceScale(session, true, false)).toMatchObject({
      hasVwap: true,
      domain: [9200, 9300],
      ticks: [9200, 9225, 9250, 9275, 9300],
    })
    expect(priceScale(session, false, false)).toMatchObject({
      hasVwap: false,
      domain: [9200, 9260],
    })
  })

  test("volume pushes the price domain down so the line clears the bars", () => {
    const scale = priceScale(session, false, true)
    expect(scale.hasVolume).toBe(true)
    expect(scale.maxVolume).toBe(10_000)
    // 45% of the 60-point tick range below the lowest tick; ticks unchanged.
    expect(scale.domain).toEqual([9173, 9260])
    expect(scale.ticks[0]).toBe(9200)
  })
})

describe("priceReadoutRows", () => {
  test("lists price, then VWAP and volume when the point has them and they are shown", () => {
    expect(priceReadoutRows(session[0]!, true, true)).toEqual([
      { label: "Harga", value: "Rp9,200", swatch: "var(--text-secondary)" },
      { label: "VWAP", value: "Rp9,210", swatch: "var(--chart-vwap)" },
      {
        label: "Volume",
        value: "4 K shares",
        swatch: "var(--chart-volume)",
      },
    ])
  })

  test("hidden overlays and missing values leave only the price", () => {
    expect(
      priceReadoutRows(session[0]!, false, false).map((r) => r.label)
    ).toEqual(["Harga"])
    expect(
      priceReadoutRows(session[2]!, true, true).map((r) => r.label)
    ).toEqual(["Harga"])
  })
})
