// Seam (b) of spec apinrdw/kumora#138, choosing the selected stock code: the
// chart header's search, the `/` and Ctrl+K palette, and a tape row. Each
// lands in the URL and goes down the viewer socket as a new Select.
import type { Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import {
  freshTradeNumbers,
  openIngest,
  session1Today,
  wibToday,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

// The page's viewer socket, passed through Playwright so the test reads each
// Select the page sends.
async function recordSelects(page: Page) {
  const selected: Array<string> = []
  await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((message) => {
      const select = JSON.parse(String(message))
      selected.push(select.selected)
      server.send(message)
    })
  })
  return selected
}

test.use({ storageState: MEMBER.storageState })

test.beforeEach(async ({ request }) => {
  const relay = await openIngest()
  await relay.sendCodeList()
  // Stored once the object has handled it.
  const url = `${DASHBOARD}/market-live/days/${wibToday()}/codes`
  await expect.poll(async () => (await request.get(url)).status()).toBe(200)
  relay.close()
})

test("the day's code list is served for the day, cacheable", async ({
  request,
}) => {
  const response = await request.get(
    `${DASHBOARD}/market-live/days/${wibToday()}/codes`
  )
  expect(response.headers()["cache-control"]).toMatch(/^private, max-age=\d+$/)
  const { codes } = await response.json()
  expect(codes).toContainEqual({
    code: "WIFI-R",
    name: "HMETD Solusi Sinergi Digital Tbk.",
    kind: "right",
  })
})

test("a signed-out code list GET answers 401", async ({ browser }) => {
  // A new context inherits the member's storageState unless given another.
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  })
  const response = await context.request.get(
    `${DASHBOARD}/market-live/days/${wibToday()}/codes`
  )
  expect(response.status()).toBe(401)
  await context.close()
})

test("the chart header's search selects a code, shares above rights", async ({
  page,
}) => {
  const selected = await recordSelects(page)
  await page.goto(`${DASHBOARD}${PAGE}`)
  const chart = page.getByRole("region", { name: "Chart" })
  await expect(chart.getByRole("heading", { name: "BBCA" })).toBeVisible()
  await expect.poll(() => selected).toEqual(["BBCA"])

  const search = chart.getByRole("combobox", { name: "Search stock code" })
  await search.fill("wifi")
  const options = chart.getByRole("option")
  await expect(options).toHaveCount(2)
  await expect(options.nth(0)).toContainText("WIFI")
  await expect(options.nth(0)).not.toContainText("Right")
  await expect(options.nth(1)).toContainText("WIFI-R")
  await expect(options.nth(1)).toContainText("Right")

  await options.nth(0).click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=WIFI`)
  await expect(chart.getByRole("heading", { name: "WIFI" })).toBeVisible()
  await expect.poll(() => selected).toEqual(["BBCA", "WIFI"])

  // The keyboard: arrows move, Enter picks.
  await search.fill("amag")
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=AMAG-W2`)
  await expect.poll(() => selected).toEqual(["BBCA", "WIFI", "AMAG-W2"])
})

test("the / and Ctrl+K palette selects a code", async ({ page }) => {
  const selected = await recordSelects(page)
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect.poll(() => selected).toEqual(["BBCA"])

  await page.keyboard.press("/")
  const palette = page.getByRole("dialog", { name: "Go to code" })
  await expect(palette).toBeVisible()
  await page.keyboard.type("bbri")
  await page.keyboard.press("Enter")
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=BBRI`)
  await expect.poll(() => selected).toEqual(["BBCA", "BBRI"])

  await page.keyboard.press("Control+k")
  await expect(palette).toBeVisible()
  await page.keyboard.type("GOTO")
  await palette.getByRole("option", { name: /GOTO/ }).click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=GOTO`)
  await expect.poll(() => selected).toEqual(["BBCA", "BBRI", "GOTO"])
})

test("clicking a tape row selects its code", async ({ page }) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  await relay.sendAjaib(session1Today(base).slice(0, 10))
  const selected = await recordSelects(page)
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect.poll(() => selected).toEqual(["BBCA"])
  const tape = page.getByRole("region", { name: "Running trades" })
  const row = tape.locator(`tr[data-trade-number="${base + 22265}"]`)
  await expect(row).toContainText("BREN")
  await row.click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=BREN`)
  await expect(
    page.getByRole("region", { name: "Chart" }).getByRole("heading", {
      name: "BREN",
    })
  ).toBeVisible()
  await expect.poll(() => selected).toEqual(["BBCA", "BREN"])
  relay.close()
})

test("the selected code survives a reload, and a bad one falls back", async ({
  page,
}) => {
  const selected = await recordSelects(page)
  await page.goto(`${DASHBOARD}${PAGE}?code=GOTO`)
  const chart = page.getByRole("region", { name: "Chart" })
  await expect(chart.getByRole("heading", { name: "GOTO" })).toBeVisible()
  // Hydrated, its socket open.
  await expect.poll(() => selected).toEqual(["GOTO"])
  await page.reload()
  await expect(chart.getByRole("heading", { name: "GOTO" })).toBeVisible()
  await expect.poll(() => selected).toEqual(["GOTO", "GOTO"])

  await page.goto(`${DASHBOARD}${PAGE}?code=not%20a%20code`)
  await expect(chart.getByRole("heading", { name: "BBCA" })).toBeVisible()
})
