import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.use({ storageState: MEMBER.storageState })

test("the footprint chart's tabs, imbalance select and POC and VWAP toggles change its drawing, and every chart setting survives a reload", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  // A code of its own: today's object keeps every code's footprints.
  const code = freshCode("FC")
  const time = wibTime(marketNow())
  // One minute: 30 lots bought at 505 over 9 sold at 500, one tick below.
  // 30 ≥ 3 × 9 is an imbalance at 2× and 3×, not at 4×; 505 is the POC.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 500,
      lot: 9,
      type: "SELL",
    }),
    ajaibTradeToday({ seq: base + 2, time, ticker: code, price: 505, lot: 30 }),
  ])
  // A desktop's width: the footprint's cells draw as text.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const footprint = page.getByRole("region", { name: "Footprint" })
  const canvas = footprint.locator('[data-chart="footprint"]')
  const tabs = footprint.getByRole("tablist", { name: "Footprint view" })
  const imbalance = footprint.getByLabel("Imbalance")
  const poc = footprint.getByRole("button", { name: "POC" })
  const vwap = footprint.getByRole("button", { name: "VWAP ±σ" })

  // The defaults: Stacked, 3×, POC and VWAP on.
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Stacked")
  await expect(imbalance).toHaveValue("3")
  await expect(canvas).toHaveAttribute("data-draw-mode", "text")
  await expect(canvas).toHaveAttribute("data-view-mode", "stacked")
  await expect(canvas).toHaveAttribute("data-imbalances", "1")
  await expect(canvas).toHaveAttribute("data-pocs", "1")
  // The VWAP and its six bands, one point each so far.
  await expect(canvas).toHaveAttribute("data-vwap-points", "7")
  // The header reads the latest minute: (9 × 500 + 30 × 505) / 39.
  const header = footprint.getByRole("group", { name: "Footprint minute" })
  await expect(header).toContainText("39 lots, 2 fills")
  await expect(header).toContainText("Buy 30")
  await expect(header).toContainText("Sell 9")
  await expect(header).toContainText("Δ +21")
  await expect(header).toContainText("VWAP 503.8")
  await expect(header).toContainText("POC 505")

  // Each tab draws its view; Candles draws no cells, so no imbalance or POC.
  for (const [name, mode] of [
    ["Side by side", "side"],
    ["Footprint", "profile"],
  ] as const) {
    await tabs.getByRole("tab", { name }).click()
    await expect(canvas).toHaveAttribute("data-view-mode", mode)
    await expect(canvas).toHaveAttribute("data-imbalances", "1")
    await expect(canvas).toHaveAttribute("data-pocs", "1")
  }
  await tabs.getByRole("tab", { name: "Candles" }).click()
  await expect(canvas).toHaveAttribute("data-view-mode", "candles")
  await expect(canvas).toHaveAttribute("data-imbalances", "0")
  await expect(canvas).toHaveAttribute("data-pocs", "0")
  // The footer, VWAP and header stay.
  await expect(canvas).toHaveAttribute("data-footer", "labelled")
  await expect(canvas).toHaveAttribute("data-vwap-points", "7")
  await expect(header).toContainText("POC 505")

  await tabs.getByRole("tab", { name: "Stacked" }).click()
  await imbalance.selectOption("4×")
  await expect(canvas).toHaveAttribute("data-imbalances", "0")
  await imbalance.selectOption("Off")
  await expect(canvas).toHaveAttribute("data-imbalances", "0")
  await imbalance.selectOption("2×")
  await expect(canvas).toHaveAttribute("data-imbalances", "1")

  await poc.click()
  await expect(poc).toHaveAttribute("aria-pressed", "false")
  await expect(canvas).toHaveAttribute("data-pocs", "0")
  await vwap.click()
  await expect(vwap).toHaveAttribute("aria-pressed", "false")
  await expect(canvas).toHaveAttribute("data-vwap-points", "0")

  // The candle chart's top-N is remembered with them.
  const chart = page.getByRole("region", { name: "Chart" })
  await tabs.getByRole("tab", { name: "Side by side" }).click()
  await chart.getByRole("button", { name: "10%" }).click()
  await expect(chart.getByLabel("Top N percent of sweeps")).toHaveValue("10")

  await page.reload()
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
    "Side by side"
  )
  await expect(canvas).toHaveAttribute("data-view-mode", "side")
  await expect(imbalance).toHaveValue("2")
  await expect(poc).toHaveAttribute("aria-pressed", "false")
  await expect(canvas).toHaveAttribute("data-pocs", "0")
  await expect(vwap).toHaveAttribute("aria-pressed", "false")
  await expect(canvas).toHaveAttribute("data-vwap-points", "0")
  await expect(chart.getByRole("button", { name: "10%" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(chart.getByLabel("Top N percent of sweeps")).toHaveValue("10")
  relay.close()
})
