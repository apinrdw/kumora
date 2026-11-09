// Seam (b) of spec apinrdw/kumora#138, the watchlist: codes added through
// Add code… survive a reload, × removes one, a code with no figures says so,
// and an Ajaib PRICE frame fills its row while Stockbit is lost. The page's
// codes go down the relay's ingest socket as the Ajaib on-demand set.
import type { Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { openIngest, wibToday } from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

// Loads the page and waits until it is hydrated: its viewer socket opens from
// an effect.
async function open(page: Page) {
  const live = page.waitForEvent("websocket", (socket) =>
    socket.url().endsWith("/market-live/live")
  )
  await page.goto(`${DASHBOARD}${PAGE}`)
  await live
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

test("the watchlist survives a reload, and × removes a code", async ({
  page,
}) => {
  await open(page)
  const watchlist = page.getByRole("region", { name: "Watchlist" })
  await expect(watchlist).toContainText("No codes yet. Add one above.")

  const add = watchlist.getByRole("combobox", { name: "Add code…" })
  for (const code of ["BREN", "AMAG"]) {
    await add.fill(code.toLowerCase())
    await watchlist
      .getByRole("option", { name: new RegExp(`^${code}`) })
      .first()
      .click()
  }
  const rows = watchlist.locator("tbody tr")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("BREN")
  await expect(rows.nth(1)).toContainText("AMAG")

  await page.reload()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("BREN")
  await expect(rows.nth(1)).toContainText("AMAG")

  await watchlist.getByRole("button", { name: "Remove BREN" }).click()
  await expect(rows).toHaveCount(1)
  await page.reload()
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText("AMAG")

  // A code's button selects it.
  await rows.nth(0).getByRole("button", { name: "AMAG", exact: true }).click()
  await expect(page).toHaveURL(`${DASHBOARD}${PAGE}?code=AMAG`)
})

test("a watched code's row fills from Ajaib's PRICE, and the relay is asked for it", async ({
  page,
}) => {
  const relay = await openIngest()
  await open(page)
  const watchlist = page.getByRole("region", { name: "Watchlist" })
  const add = watchlist.getByRole("combobox", { name: "Add code…" })
  await add.fill("wifi")
  await watchlist
    .getByRole("option", { name: /^WIFI\b/ })
    .first()
    .click()
  const row = watchlist.locator('tr[data-code="WIFI"]')
  await expect(row).toContainText("no data yet")

  // The selected BBCA and the watched WIFI.
  await expect
    .poll(
      () =>
        relay.received
          .map((text) => JSON.parse(text))
          .filter((message) => message._tag === "OnDemandCodes")
          .at(-1)?.codes
    )
    .toEqual(expect.arrayContaining(["BBCA", "WIFI"]))

  // Stockbit lost (another spec may have sent its frames moments ago), so
  // Ajaib's figures stand in: the 2026-11-06 BBCA PRICE frame's shape, as
  // WIFI's today.
  await relay.report("Stockbit", "closed")
  await relay.sendAjaib([
    JSON.stringify({
      ticker: "WIFI",
      updateTime: Date.now(),
      price: 4120,
      change: 70,
      pctChange: 0.017284,
      tradableVolume: 1234500,
      hi: 4150,
      lo: 4030,
      open: 4050,
      close: 4050,
      p: 0,
      co: 2795,
      s: 2798,
      eb: 3,
    }),
  ])
  await expect(row).toContainText("4,120")
  await expect(row).toContainText("+70")
  await expect(row).toContainText("+1.73%")
  await expect(watchlist.getByText("Ajaib", { exact: true })).toBeVisible()
  relay.close()
})
