// Market Live's middle column of tabs (apinrdw/kumora#702): the selected
// code's sweep log and the running trades, beside the watchlist and order
// book. A hidden tab stays mounted, and the tab is kept in the URL.
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

test.use({
  storageState: MEMBER.storageState,
  viewport: { width: 1920, height: 1080 },
})

test("the sweep log and the running trades share the middle column as tabs, and the tape keeps streaming while hidden", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("TB")
  const time = wibTime(marketNow())
  // Two sweeps: a 10-lot buy and a 1-lot sell.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 500,
      lot: 10,
      type: "BUY",
    }),
    ajaibTradeToday({
      seq: base + 2,
      time,
      ticker: code,
      price: 495,
      lot: 1,
      type: "SELL",
    }),
  ])
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)

  const tabs = page.getByRole("tablist", { name: "Trades" })
  await expect(tabs.getByRole("tab")).toHaveText([
    `Buy/Sell sweeps · ${code}`,
    "All codes",
    "Running trades",
  ])
  const log = page.getByRole("region", { name: "Sweep log" })
  const tape = page.getByRole("region", { name: "Running trades" })
  const watchlist = page.getByRole("region", { name: "Watchlist" })
  const book = page.getByRole("region", { name: "Order book" })
  // No tab in the URL: the sweep log shows.
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
    `Buy/Sell sweeps · ${code}`
  )
  await expect(log).toBeVisible()
  await expect(tape).toBeHidden()
  await expect(log).toContainText("2 sweeps")

  // The tabs sit over the log, in the column between the charts and the
  // watchlist and book, which have the right column to themselves.
  const [chartBox, tabsBox, logBox, watchBox, bookBox] = await Promise.all(
    [
      page.getByRole("region", { name: "Chart" }),
      tabs,
      log,
      watchlist,
      book,
    ].map(async (region) => (await region.boundingBox())!)
  )
  expect(tabsBox.x).toBeGreaterThanOrEqual(chartBox.x + chartBox.width)
  expect(logBox.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height)
  expect(Math.abs(logBox.x - tabsBox.x)).toBeLessThan(2)
  expect(watchBox.x).toBeGreaterThanOrEqual(logBox.x + logBox.width)
  expect(Math.abs(bookBox.x - watchBox.x)).toBeLessThan(2)
  expect(bookBox.y).toBeGreaterThan(watchBox.y)

  // The log's Big only filter, set before switching away.
  const bigOnly = log.getByRole("button", { name: "Big only" })
  await bigOnly.click()
  await expect(bigOnly).toHaveAttribute("aria-pressed", "true")

  // The tape, which keeps the URL's tab.
  await tabs.getByRole("tab", { name: "Running trades" }).click()
  await expect(tape).toBeVisible()
  await expect(log).toBeHidden()
  await expect(page).toHaveURL(/[?&]panel=tape(&|$)/)
  await expect(
    tape.locator(`tr[data-trade-number="${base + 2}"]`)
  ).toBeVisible()

  // Back to the log, and a trade arrives while the tape is hidden.
  await tabs.getByRole("tab", { name: `Buy/Sell sweeps · ${code}` }).click()
  await expect(log).toBeVisible()
  await expect(bigOnly).toHaveAttribute("aria-pressed", "true")
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 3,
      time: wibTime(marketNow()),
      ticker: code,
      price: 500,
      lot: 7,
      type: "BUY",
    }),
  ])
  await expect(log).toContainText("3 sweeps")
  // Its rows draw again once shown, at the height the log came back with.
  await bigOnly.click()
  await expect(log.locator("[data-sweep-id]")).toHaveCount(3)
  await tabs.getByRole("tab", { name: "Running trades" }).click()
  await expect(
    tape.locator(`tr[data-trade-number="${base + 3}"]`)
  ).toBeVisible()

  // A reload opens the tab the URL names.
  await page.reload()
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
    "Running trades"
  )
  await expect(tape).toBeVisible()
  await expect(log).toBeHidden()
  relay.close()
})

test("an index has the running trades as its only tab", async ({ page }) => {
  await page.goto(`${DASHBOARD}${PAGE}?code=IHSG`)
  const tabs = page.getByRole("tablist", { name: "Trades" })
  await expect(tabs.getByRole("tab")).toHaveText(["Running trades"])
  await expect(
    page.getByRole("region", { name: "Running trades" })
  ).toBeVisible()
  await expect(page.getByRole("region", { name: "Sweep log" })).toHaveCount(0)
  // A sweeps tab in the URL falls back to the tape.
  await page.goto(`${DASHBOARD}${PAGE}?code=IHSG&panel=sweeps`)
  await expect(
    page.getByRole("region", { name: "Running trades" })
  ).toBeVisible()
})
