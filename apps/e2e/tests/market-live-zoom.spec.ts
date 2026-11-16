import type { Locator, Page } from "@playwright/test"

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
const SETTINGS = "kumora:market-live:charts"

test.use({ storageState: MEMBER.storageState })

// A chart's visible range, in bars, as the pair marks it.
const widthOf = async (chart: Locator) => {
  const [from, to] = await Promise.all([
    chart.getAttribute("data-from"),
    chart.getAttribute("data-to"),
  ])
  return Number(to) - Number(from)
}

const stretchOf = async (chart: Locator) =>
  Number(await chart.getAttribute("data-price-stretch"))

// The zoom this browser saved for both charts.
const savedZoom = (page: Page) =>
  page.evaluate(
    (key) =>
      (JSON.parse(localStorage.getItem(key) ?? "{}") as { zoom?: unknown })
        .zoom,
    SETTINGS
  )

// A drag on `chart`'s price axis, up from 40% of its height: Lightweight
// Charts tightens the axis.
const dragPriceAxis = async (page: Page, chart: Locator) => {
  const box = (await chart.boundingBox())!
  const x = box.x + box.width - 20
  const y = box.y + box.height * 0.4
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 120, { steps: 8 })
  await page.mouse.up()
}

const wheelOn = async (page: Page, chart: Locator) => {
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3)
  await page.mouse.wheel(0, -600)
  await page.mouse.wheel(0, -600)
}

test("each chart keeps its own time and price zoom across a reload, until a double click on an axis brings back the default", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("ZM")
  const now = marketNow()
  // 20 minutes up to now, over 500 to 520.
  await relay.sendAjaib(
    Array.from({ length: 20 }, (_, index) =>
      ajaibTradeToday({
        seq: base + index + 1,
        time: wibTime(now - (19 - index) * 60_000),
        ticker: code,
        price: 500 + (index % 5) * 5,
        lot: 100,
      })
    )
  )
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  await expect(page.getByRole("region", { name: "Footprint" })).toContainText(
    "Footprint minutes: 20"
  )
  const candles = page.locator('[data-chart="candles"]')
  const footprint = page.locator('[data-chart="footprint"]')

  // The defaults: the footprint chart on 10 minutes, each axis on its fit.
  await expect.poll(() => widthOf(footprint)).toBe(9)
  await expect(candles).toHaveAttribute("data-price-stretch", "1.000")
  await expect(footprint).toHaveAttribute("data-price-stretch", "1.000")
  const candlesDefault = await widthOf(candles)
  expect(await savedZoom(page)).toBeUndefined()

  // The wheel zooms each chart in time, its price axis drag in price.
  await wheelOn(page, candles)
  await expect.poll(() => widthOf(candles)).toBeLessThan(candlesDefault - 1)
  await dragPriceAxis(page, candles)
  await expect.poll(() => stretchOf(candles)).toBeGreaterThan(1.2)
  await wheelOn(page, footprint)
  await expect.poll(() => widthOf(footprint)).toBeLessThan(8.5)
  await dragPriceAxis(page, footprint)
  await expect.poll(() => stretchOf(footprint)).toBeGreaterThan(1.2)
  // Each saved once its gesture is over: the wheel's once it rests.
  await expect
    .poll(() => savedZoom(page))
    .toMatchObject({
      candles: {
        barSpacing: expect.any(Number),
        priceStretch: expect.any(Number),
      },
      footprint: {
        minutes: expect.any(Number),
        priceStretch: expect.any(Number),
      },
    })
  const zoomed = {
    candles: await widthOf(candles),
    footprint: await widthOf(footprint),
    candleStretch: await candles.getAttribute("data-price-stretch"),
    footprintStretch: await footprint.getAttribute("data-price-stretch"),
  }
  // Neither zoom reached the other chart.
  expect(zoomed.candles).not.toBeCloseTo(zoomed.footprint, 0)

  // A pan is no zoom: the saved zoom stays.
  const saved = await savedZoom(page)
  const box = (await candles.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height * 0.4, {
    steps: 8,
  })
  await page.mouse.up()
  expect(await savedZoom(page)).toEqual(saved)

  await page.reload()
  await expect.poll(() => widthOf(footprint)).toBeCloseTo(zoomed.footprint, 1)
  await expect.poll(() => widthOf(candles)).toBeCloseTo(zoomed.candles, 1)
  await expect(candles).toHaveAttribute(
    "data-price-stretch",
    zoomed.candleStretch!
  )
  await expect(footprint).toHaveAttribute(
    "data-price-stretch",
    zoomed.footprintStretch!
  )

  // A double click on the time axis, then on the price axis: each chart's
  // default.
  for (const chart of [candles, footprint]) {
    await chart.scrollIntoViewIfNeeded()
    const at = (await chart.boundingBox())!
    await page.mouse.dblclick(at.x + at.width * 0.4, at.y + at.height - 8)
    await page.mouse.dblclick(at.x + at.width - 20, at.y + at.height * 0.3)
  }
  await expect.poll(() => widthOf(footprint)).toBe(9)
  await expect.poll(() => widthOf(candles)).toBeCloseTo(candlesDefault, 0)
  await expect(candles).toHaveAttribute("data-price-stretch", "1.000")
  await expect(footprint).toHaveAttribute("data-price-stretch", "1.000")
  await expect
    .poll(() => savedZoom(page))
    .toEqual({ candles: {}, footprint: {} })

  await page.reload()
  await expect.poll(() => widthOf(footprint)).toBe(9)
  await expect.poll(() => widthOf(candles)).toBeCloseTo(candlesDefault, 0)
  await expect(candles).toHaveAttribute("data-price-stretch", "1.000")
  await expect(footprint).toHaveAttribute("data-price-stretch", "1.000")
  relay.close()
})
