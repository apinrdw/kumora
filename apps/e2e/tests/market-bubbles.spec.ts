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

// The viewport point of a canvas centre the `attribute` names, once the
// layout has about stopped moving it: within 2 px of where it was a poll ago.
async function settledAt(canvas: Locator, attribute: string) {
  let last: string | null = null
  await expect
    .poll(
      async () => {
        const at = await canvas.getAttribute(attribute)
        const [x = 0, y = 0] = (at ?? "").split(",").map(Number)
        const [px = 1e9, py = 1e9] = (last ?? "").split(",").map(Number)
        last = at
        return at !== null && Math.hypot(x - px, y - py) <= 2
      },
      { intervals: [300], timeout: 15_000 }
    )
    .toBe(true)
  const [x, y] = last!.split(",").map(Number)
  const box = (await canvas.boundingBox())!
  return { x: box.x + x!, y: box.y + y! }
}

// The largest bubble's centre in the viewport, once it is `code`'s and the
// layout has about stopped moving it.
async function largestBubble(canvas: Locator, code: string) {
  await expect(canvas).toHaveAttribute("data-largest", code)
  return settledAt(canvas, "data-largest-at")
}

// A PNG's width and height, from its IHDR chunk.
const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
})

// A 1 × 1 PNG, answered for every logo.
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

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

test("a link's Top N leaves the URL when it is the device's default, and stays when not", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const top = (n: string) =>
    page.getByRole("group", { name: "Codes shown" }).getByRole("button", {
      name: n,
    })
  await page.goto(`${DASHBOARD}${PAGE}?top=100&window=1m`)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?window=1m`)
  await expect(top("Top 100")).toHaveAttribute("aria-pressed", "true")
  await page.goto(`${DASHBOARD}${PAGE}?top=50`)
  await expect(top("Top 50")).toHaveAttribute("aria-pressed", "true")
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?top=50`)
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

test("search rings a code without moving the map, a drag lets it go home, and the snapshot saves the map with its caption", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page.locator('[data-flow="live"]')).toHaveCount(1)

  // Big enough to hover and drag, yet smaller than the first test's code,
  // which leads the map: this test finds its code by search, not by size.
  const code = freshCode("BS")
  const relay = await openIngest()
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: freshTradeNumbers() + 1,
      time: wibTime(marketNow()),
      ticker: code,
      price: 50_000,
      lot: 50_000,
    }),
  ])
  relay.close()

  // The header strip counts the day so far.
  const strip = page.getByRole("group", { name: "Market figures" })
  await expect(strip.getByLabel("Value")).toContainText("Rp")
  await expect(strip.getByLabel("Market clock")).toContainText("WIB")

  const canvas = page.getByRole("img", { name: /^Market Bubbles:/ })
  await expect(canvas).toHaveAttribute("data-matches", "0")
  await settledAt(canvas, "data-largest-at")
  const shown = await canvas.getAttribute("data-bubbles")
  await page.getByRole("searchbox", { name: "Find a stock code" }).fill(code)
  await expect(canvas).toHaveAttribute("data-matches", "1")
  // Search only highlights: every bubble stays on the map.
  expect(await canvas.getAttribute("data-bubbles")).toBe(shown)
  const found = await settledAt(canvas, "data-match-at")

  // Hovering shows its figures; its bubble grows without moving away from
  // under the pointer, so the tooltip stays.
  await page.mouse.move(found.x, found.y)
  const tip = page.getByRole("tooltip", { name: `${code} figures` })
  await expect(tip).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(tip).toBeVisible()

  // A drag holds it under the pointer, opens nothing, and on release it eases
  // back toward the cluster.
  await page.mouse.down()
  const to = { x: found.x - 240, y: found.y + 60 }
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await expect
    .poll(async () => {
      const box = (await canvas.boundingBox())!
      const [x = 0, y = 0] = (await canvas.getAttribute("data-match-at"))!
        .split(",")
        .map(Number)
      return Math.hypot(box.x + x - to.x, box.y + y - to.y)
    })
    .toBeLessThan(3)
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await page.mouse.up()
  const home = await settledAt(canvas, "data-match-at")
  expect(Math.hypot(home.x - to.x, home.y - to.y)).toBeGreaterThan(60)
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)

  // The snapshot: the canvas at its pixel ratio, with the caption strip
  // under it, named for the time in WIB.
  const ratio = await page.evaluate(() => Math.min(2, window.devicePixelRatio))
  const box = (await canvas.boundingBox())!
  const saved = page.waitForEvent("download")
  await page.getByRole("button", { name: "Snapshot" }).click()
  const download = await saved
  expect(download.suggestedFilename()).toMatch(
    /^market-bubbles-\d{8}-\d{6}\.png$/
  )
  const chunks: Array<Buffer> = []
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk as Buffer)
  const png = Buffer.concat(chunks)
  expect(png.subarray(1, 4).toString()).toBe("PNG")
  const size = pngSize(png)
  expect(size.width).toBe(Math.round(box.width * ratio))
  expect(size.height).toBe(
    Math.round(box.height * ratio) + Math.round(34 * ratio)
  )
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

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("a link's Top 50 leaves the URL, and its Top 100 stays", async ({
    page,
  }) => {
    const pressed = async (n: string) => {
      await page.getByRole("button", { name: "Filters" }).tap()
      const sheet = page.getByRole("dialog", { name: "Filters" })
      await expect(
        sheet.getByRole("group", { name: "Codes shown" }).getByRole("button", {
          name: n,
        })
      ).toHaveAttribute("aria-pressed", "true")
      await sheet.getByRole("button", { name: "Close" }).tap()
      await expect(sheet).toHaveCount(0)
    }
    const live = page.locator('[data-flow="live"]')
    await page.goto(`${DASHBOARD}${PAGE}?top=50`)
    await expect(live).toHaveCount(1)
    await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
    await pressed("Top 50")
    await page.goto(`${DASHBOARD}${PAGE}?top=100`)
    await expect(live).toHaveCount(1)
    await pressed("Top 100")
    await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?top=100`)
  })

  test("the Filters sheet opens on Top 50, a tap shows a bubble's figures, a tap on another moves them, and a second tap opens Market Live", async ({
    page,
  }) => {
    // Two sectors, so the first code's grown bubble never covers the second.
    const first = freshCode("BP")
    const second = freshCode("BQ")
    seedStockSectors({ [first]: "Energy" })
    await page.goto(`${DASHBOARD}${PAGE}`)
    await expect(page.locator('[data-flow="live"]')).toHaveCount(1)

    // Big enough to tap, under the first test's Rp2.00 T.
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const time = wibTime(marketNow())
    await relay.sendAjaib(
      [first, second].map((ticker, index) =>
        ajaibTradeToday({
          seq: base + index + 1,
          time,
          ticker,
          price: 50_000,
          lot: 50_000,
        })
      )
    )
    relay.close()

    // Every control is in the sheet, and the phone's Top 50 stays out of the
    // URL.
    const canvas = page.getByRole("img", { name: /^Market Bubbles:/ })
    expect((await canvas.boundingBox())!.width).toBeGreaterThan(340)
    const find = async (code: string) => {
      await page.getByRole("button", { name: "Filters" }).tap()
      const sheet = page.getByRole("dialog", { name: "Filters" })
      await expect(
        sheet
          .getByRole("group", { name: "Codes shown" })
          .getByRole("button", { name: "Top 50" })
      ).toHaveAttribute("aria-pressed", "true")
      await expect(
        sheet.getByRole("combobox", { name: "Sector" })
      ).toBeVisible()
      await sheet
        .getByRole("searchbox", { name: "Find a stock code" })
        .fill(code)
      await sheet.getByRole("button", { name: "Close" }).tap()
      await expect(sheet).toHaveCount(0)
      await expect(canvas).toHaveAttribute("data-matches", "1")
      return settledAt(canvas, "data-match-at")
    }
    expect(page.url()).toBe(`${DASHBOARD}${PAGE}`)

    // Only the canvas takes the finger's drag; the page scrolls elsewhere.
    expect(
      await canvas.evaluate((surface) => getComputedStyle(surface).touchAction)
    ).toBe("none")
    expect(
      await page.evaluate(() => getComputedStyle(document.body).touchAction)
    ).toBe("auto")

    const at = await find(first)
    await page.touchscreen.tap(at.x, at.y)
    await expect(
      page.getByRole("tooltip", { name: `${first} figures` })
    ).toBeVisible()

    const next = await find(second)
    await page.touchscreen.tap(next.x, next.y)
    await expect(
      page.getByRole("tooltip", { name: `${second} figures` })
    ).toBeVisible()
    await expect(page.getByRole("tooltip")).toHaveCount(1)
    await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)

    await page.touchscreen.tap(next.x, next.y)
    await expect(page).toHaveURL(`${DASHBOARD}/market-live?code=${second}`)
  })
})
