// Market Live's bubble panel (spec apinrdw/kumora#427, "The Market Live
// panel"): its code sets and windows, remembered per browser; a click selects
// its code in place; none on a recorded day.
import type { Locator, Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import { seedStockSectors } from "../support/holdings"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
  wibToday,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"
const WATCHLIST_KEY = "kumora:market-live:watchlist"

test.use({ storageState: MEMBER.storageState })

const panelOf = (page: Page) =>
  page.getByRole("region", { name: "Bubbles", exact: true })

const setButton = (panel: Locator, name: string) =>
  panel
    .getByRole("group", { name: "Bubble codes" })
    .getByRole("button", { name, exact: true })

const windowButton = (panel: Locator, name: string) =>
  panel
    .getByRole("group", { name: "Bubbles window" })
    .getByRole("button", { name, exact: true })

// The panel's codes, largest first.
const codesOf = async (panel: Locator) =>
  ((await panel.getAttribute("data-codes")) ?? "").split(" ")

// The largest bubble's centre in the viewport, once it is `code`'s and the
// layout has about stopped moving it: within 2 px of where it was a poll ago.
async function largestBubble(canvas: Locator, code: string) {
  await expect(canvas).toHaveAttribute("data-largest", code)
  await canvas.scrollIntoViewIfNeeded()
  let last: string | null = null
  await expect
    .poll(
      async () => {
        const at = await canvas.getAttribute("data-largest-at")
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

test("the panel shows the market top, the watchlist or the selected code's sector, remembers them, and a click selects in place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  // Codes of their own, the largest far larger than any other test's, two in
  // one sector and one in another.
  const large = freshCode("BA")
  const watched = freshCode("BB")
  const elsewhere = freshCode("BC")
  seedStockSectors({
    [large]: "Infrastructures",
    [watched]: "Infrastructures",
    [elsewhere]: "Energy",
  })
  await page.addInitScript(
    ([key, seeded]) => window.localStorage.setItem(key, JSON.stringify(seeded)),
    [WATCHLIST_KEY, [watched, large]] as const
  )

  await page.goto(`${DASHBOARD}${PAGE}?code=${watched}`)
  // The socket's snapshot came: the trades below reach the page as deltas,
  // not in a backfill built before them.
  await expect(
    page
      .getByRole("group", { name: "Market conditions" })
      .getByRole("list", { name: "Feeds" })
  ).toBeVisible()
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const time = wibTime(marketNow())
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: large,
      price: 50_000,
      lot: 300_000,
    }),
    ajaibTradeToday({
      seq: base + 2,
      time,
      ticker: watched,
      price: 1_000,
      lot: 100,
    }),
    ajaibTradeToday({
      seq: base + 3,
      time,
      ticker: elsewhere,
      price: 1_000,
      lot: 100,
      type: "SELL",
    }),
  ])
  relay.close()
  const panel = panelOf(page)
  // It opens on the market top over 5m.
  await expect(setButton(panel, "Market top 60")).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(windowButton(panel, "5m")).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect.poll(() => codesOf(panel)).toContain(large)
  expect((await codesOf(panel)).length).toBeLessThanOrEqual(60)

  // The watchlist's codes alone, largest first.
  await setButton(panel, "Watchlist").click()
  await expect(panel).toHaveAttribute("data-codes", `${large} ${watched}`)
  const canvas = panel.getByRole("img", { name: /^Market Bubbles:/ })
  await expect(canvas).toHaveAttribute("data-ringed", watched)

  // A click on a bubble selects its code on Market Live, in place, and rings
  // it.
  const at = await largestBubble(canvas, large)
  await page.mouse.click(at.x, at.y)
  await expect(page).toHaveURL(new RegExp(`${PAGE}\\?.*code=${large}`))
  await expect(
    page.getByRole("region", { name: "Chart" }).getByRole("heading", {
      name: large,
    })
  ).toBeVisible()
  await expect(canvas).toHaveAttribute("data-ringed", large)

  // The selected code's sector: its sector's codes, not the other's.
  await setButton(panel, "Sector of selected").click()
  await expect.poll(() => codesOf(panel)).toContain(watched)
  const sector = await codesOf(panel)
  expect(sector).toContain(large)
  expect(sector).not.toContain(elsewhere)

  // The window and the set are this browser's after a reload, and the link
  // opens the full page on the panel's window.
  await windowButton(panel, "15m").click()
  await page.reload()
  await expect(setButton(panel, "Sector of selected")).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(windowButton(panel, "15m")).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(
    panel.getByRole("link", { name: "Open Market Bubbles ↗" })
  ).toHaveAttribute("href", /\/market-bubbles\?window=15m$/)

  // An index has no sector: Sector of selected can't be picked, and the
  // panel shows the market top meanwhile.
  await page.goto(`${DASHBOARD}${PAGE}?code=IHSG`)
  await expect(setButton(panel, "Sector of selected")).toBeDisabled()
  await expect(setButton(panel, "Market top 60")).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

test("a recorded day has no bubble panel and no Bubbles tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(panelOf(page)).toBeVisible()
  await page.goto(`${DASHBOARD}${PAGE}?day=${wibToday()}`)
  await expect(page.getByRole("region", { name: "Chart" })).toBeVisible()
  await expect(panelOf(page)).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  const tabs = page.getByRole("tablist", { name: "Panels" })
  await expect(tabs.getByRole("tab")).toHaveText([
    "Sweeps",
    "Watchlist",
    "Order book",
    "Tape",
  ])
})
