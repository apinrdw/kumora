import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { BrokerInventoryChart } from "@/components/stocks/broker-inventory-chart"
import type { CandleColumns } from "@/server/broker-totals/inventory"

const DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map(
  (day) => WibDate.make(day)
)
// Nov 12 is a gap: never built, so the read has no candle for it.
const BUILT = [true, true, false, true]
const CANDLES: CandleColumns = {
  day: [0, 1, 3],
  open: [9_000, 9_100, 9_150],
  high: [9_150, 9_200, 9_400],
  low: [8_950, 9_050, 9_100],
  close: [9_100, 9_050, 9_350],
  volume: [1_000, 400, 2_500],
  value: [0, 0, 0],
}

const render = (
  marked: number | undefined = undefined,
  selection: readonly [number, number] | undefined = undefined
) =>
  renderAt("/stocks/BBCA?tab=brokers", () => (
    <BrokerInventoryChart
      marked={marked}
      pinned={false}
      selection={selection}
      onHover={() => undefined}
      onPin={() => undefined}
      onSelect={() => undefined}
      code={StockCode.make("BBCA")}
      days={DAYS}
      built={BUILT}
      candles={CANDLES}
      lines={[
        {
          broker: BrokerCode.make("YP"),
          color: "red",
          values: [100, 200, 200, 300],
        },
      ]}
    />
  ))

const count = (html: string, pattern: RegExp) =>
  [...html.matchAll(pattern)].length

describe("BrokerInventoryChart", () => {
  test("links each built day's candle to that recorded day in Market Live", async () => {
    const html = await render()
    const hrefs = [...html.matchAll(/href="([^"]*market-live[^"]*)"/g)].map(
      ([, href]) => href?.replaceAll("&amp;", "&")
    )
    expect(hrefs).toStrictEqual([
      "/market-live?code=BBCA&day=2026-11-10",
      "/market-live?code=BBCA&day=2026-11-11",
      "/market-live?code=BBCA&day=2026-11-13",
    ])
    expect(html).toContain('aria-label="Open Nov 13 in Market Live"')
  })

  test("draws a volume bar for each candle and none for the gap", async () => {
    const html = await render()
    expect(count(html, /data-volume="/g)).toBe(3)
    expect(html).not.toContain('data-volume="2"')
  })

  test("labels the candles' prices on the right-hand axis", async () => {
    const html = await render()
    expect(html).toMatch(/data-price-axis="">.*>9,000<.*>9,200</)
  })

  test("draws the candles behind the broker lines", async () => {
    const html = await render()
    expect(html.indexOf("data-candles")).toBeGreaterThan(-1)
    expect(html.indexOf("data-candles")).toBeLessThan(
      html.indexOf("data-broker")
    )
  })

  test("shades a selection behind the candles and marks the hovered day", async () => {
    const plain = await render()
    expect(plain).not.toContain("data-selection")
    expect(plain).not.toContain("data-marker")
    const html = await render(3, [1, 3])
    expect(html.indexOf("data-selection")).toBeGreaterThan(-1)
    expect(html.indexOf("data-selection")).toBeLessThan(
      html.indexOf("data-candles")
    )
    expect(html).toContain('data-marker="hover"')
  })
})
