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

// A 1 × 1 PNG, answered for every logo.
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
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

test("a large bubble draws its logo from the dashboard's own origin, and the map still exports", async ({
  page,
}) => {
  // No logo is synced outside Production: a code without one answers 404.
  const missing = await page.request.get(`${DASHBOARD}/logos/BBCA`)
  expect(missing.status()).toBe(404)

  const requested: Array<string> = []
  await page.route(`${DASHBOARD}/logos/*`, (route) => {
    requested.push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: "image/png", body: LOGO })
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page.locator('[data-flow="live"]')).toHaveCount(1)

  const code = freshCode("BL")
  const served = page.waitForResponse((response) =>
    response.url().endsWith(`/logos/${code}`)
  )
  const relay = await openIngest()
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: freshTradeNumbers() + 1,
      time: wibTime(marketNow()),
      ticker: code,
      price: 50_000,
      lot: 300_000,
    }),
  ])
  relay.close()

  // Big enough for a logo, beside the other test's, which leads the map.
  await served
  const canvas = page.getByRole("img", { name: /^Market Bubbles:/ })
  expect(requested).toContain(`/logos/${code}`)
  // A tainted canvas throws here. Two frames, so the logo has been drawn.
  const exported = await canvas.evaluate(
    (surface: HTMLCanvasElement) =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(surface.toDataURL("image/png")))
        )
      )
  )
  expect(exported).toMatch(/^data:image\/png;base64,/)
})
