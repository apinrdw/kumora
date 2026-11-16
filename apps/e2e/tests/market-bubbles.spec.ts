import type { Locator, Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import { seedStockSectors } from "../support/holdings"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-bubbles"

test.use({ storageState: MEMBER.storageState })

// The largest bubble's centre in the viewport, once it is `code`'s and the
// layout has about stopped moving it.
async function largestBubble(canvas: Locator, code: string) {
  await expect(canvas).toHaveAttribute("data-largest", code)
  let last: string | null = null
  // Settled: within 2 px of where it was a poll ago.
  await expect
    .poll(
      async () => {
        const at = await canvas.getAttribute("data-largest-at")
        const [x = 0, y = 0] = (at ?? "").split(",").map(Number)
        const [px = 1e9, py = 1e9] = (last ?? "").split(",").map(Number)
        last = at
        return Math.hypot(x - px, y - py) <= 2
      },
      { intervals: [300], timeout: 15_000 }
    )
    .toBe(true)
  const [x, y] = last!.split(",").map(Number)
  const box = (await canvas.boundingBox())!
  return { x: box.x + x!, y: box.y + y! }
}

// Where `sector`'s label sits in the viewport, once its cluster has about
// stopped moving.
async function sectorLabel(canvas: Locator, sector: string) {
  let last: string | undefined
  const at = async () => {
    const labels = JSON.parse(
      (await canvas.getAttribute("data-sector-labels")) ?? "{}"
    ) as Record<string, string>
    return labels[sector]
  }
  await expect
    .poll(
      async () => {
        const now = await at()
        const [x = 0, y = 0] = (now ?? "").split(",").map(Number)
        const [px = 1e9, py = 1e9] = (last ?? "").split(",").map(Number)
        last = now
        return now !== undefined && Math.hypot(x - px, y - py) <= 2
      },
      { intervals: [300], timeout: 15_000 }
    )
    .toBe(true)
  const [x, y] = last!.split(",").map(Number)
  const box = (await canvas.boundingBox())!
  return { x: box.x + x!, y: box.y + y! }
}

const sectorLabels = async (canvas: Locator) =>
  Object.keys(
    JSON.parse((await canvas.getAttribute("data-sector-labels")) ?? "{}")
  )

const windowButton = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Window" })
    .getByRole("button", { name, exact: true })

test("the map draws the market's trades, keeps its view in the URL, and a click opens Market Live", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${DASHBOARD}/account`)
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Market Bubbles" })
    .click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  // The socket's snapshot came: what follows reaches the page as deltas.
  await expect(page.locator('[data-flow="live"]')).toHaveCount(1)

  // A code of its own, far larger than any other test's, so it leads the
  // map: today's object keeps every spec's trades.
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("BU")
  const time = wibTime(marketNow())
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 50_000,
      lot: 300_000,
    }),
    ajaibTradeToday({
      seq: base + 2,
      time,
      ticker: code,
      price: 50_000,
      lot: 100_000,
      type: "SELL",
    }),
  ])
  relay.close()

  const canvas = page.getByRole("img", { name: /^Market Bubbles:/ })
  await expect(canvas).toHaveAttribute("data-largest", code)
  await expect(windowButton(page, "5m")).toHaveAttribute("aria-pressed", "true")

  // Each window keeps it, and lands in the URL; the default leaves it.
  for (const window of ["1m", "30s", "D"]) {
    await windowButton(page, window).click()
    await expect(page).toHaveURL(new RegExp(`[?&]window=${window}(&|$)`))
    await expect(canvas).toHaveAttribute("data-largest", code)
  }
  await page
    .getByRole("group", { name: "Codes shown" })
    .getByRole("button", { name: "Top 50" })
    .click()
  await expect(page).toHaveURL(/[?&]top=50(&|$)/)
  await windowButton(page, "5m").click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?top=50`)

  // Hovering shows its figures: Rp2.00 T of value, half of it bought over the
  // sold, so a delta of +50.00%.
  const centre = await largestBubble(canvas, code)
  await page.mouse.move(centre.x, centre.y)
  const tip = page.getByRole("tooltip", { name: `${code} figures` })
  await expect(tip).toContainText("Rp2.00 T")
  await expect(tip).toContainText("+50.00%")

  await page.mouse.click(centre.x, centre.y)
  await expect(page).toHaveURL(`${DASHBOARD}/market-live?code=${code}`)
})

test("a phone's nav leads to Market Bubbles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${DASHBOARD}/market-live`)
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Bubbles" })
    .click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
})

test("a sector label's click shows that sector alone, and the Sector filter brings the rest back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  // Before the page loads: it reads the sector map once a visit.
  const code = freshCode("BS")
  seedStockSectors({ [code]: "Energy" })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page.locator('[data-flow="live"]')).toHaveCount(1)

  // An Energy code, under the other test's Rp2.00 T so it never takes that
  // test's lead, and an Unclassified one.
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const other = freshCode("BX")
  const time = wibTime(marketNow())
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 50_000,
      lot: 100_000,
    }),
    ajaibTradeToday({
      seq: base + 2,
      time,
      ticker: other,
      price: 1_000,
      lot: 1_000,
    }),
  ])
  relay.close()

  const canvas = page.getByRole("img", { name: /^Market Bubbles:/ })
  await expect.poll(() => sectorLabels(canvas)).toContain("Energy")
  await expect.poll(() => sectorLabels(canvas)).toContain("Unclassified")

  const label = await sectorLabel(canvas, "Energy")
  await page.mouse.click(label.x, label.y)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?sector=Energy`)
  await expect.poll(() => sectorLabels(canvas)).toEqual(["Energy"])
  await expect(canvas).toHaveAttribute("data-largest", code)
  await expect(page.getByRole("combobox", { name: "Sector" })).toContainText(
    "Energy"
  )

  // Unclassified is a sector like any other.
  await page.getByRole("combobox", { name: "Sector" }).click()
  await page.getByRole("option", { name: "Unclassified" }).click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?sector=Unclassified`)
  await expect.poll(() => sectorLabels(canvas)).toEqual(["Unclassified"])
  await expect(canvas).not.toHaveAttribute("data-largest", code)

  await page.getByRole("combobox", { name: "Sector" }).click()
  await page.getByRole("option", { name: "All sectors" }).click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  await expect.poll(() => sectorLabels(canvas)).toContain("Energy")
  await expect.poll(() => sectorLabels(canvas)).toContain("Unclassified")
})
