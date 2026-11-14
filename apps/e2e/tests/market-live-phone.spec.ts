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

test.use({ storageState: MEMBER.storageState })

test("an index shows candles and total volume, and one line in place of chart 2 and the sweep log", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  // The order flow GETs the page asks, by path.
  const orderFlow: Array<string> = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (/\/(heatmap|sweeps)\//.test(path)) orderFlow.push(path)
  })
  await page.goto(`${DASHBOARD}${PAGE}?code=IHSG`)
  const chart = page.getByRole("region", { name: "Chart" })
  await expect(chart.getByRole("heading", { name: "IHSG" })).toBeVisible()
  await expect(chart.locator('[data-chart="candles"]')).toBeVisible()
  await expect(page.getByText("An index has no order flow")).toHaveCount(1)
  await expect(page.getByText("An index has no order flow")).toBeVisible()
  await expect(page.getByRole("region", { name: "Footprint" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Sweep log" })).toHaveCount(0)
  // No top-N filter, as no bubbles are drawn.
  await expect(page.getByLabel("Top N percent of sweeps")).toHaveCount(0)

  // An index has no order flow to ask for.
  expect(orderFlow).toEqual([])

  // A share again: chart 2 and the log are back, and their GETs go.
  const asked = Promise.all([
    page.waitForRequest(/\/heatmap\/BBCA$/),
    page.waitForRequest(/\/sweeps\/BBCA$/),
  ])
  await page.goto(`${DASHBOARD}${PAGE}?code=BBCA`)
  await asked
  await expect(page.getByRole("region", { name: "Footprint" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Sweep log" })).toBeVisible()
  await expect(page.getByText("An index has no order flow")).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  // A finger dragged `dx` px across `target`, through Chromium's touch input.
  const touchDrag = async (page: Page, target: Locator, dx: number) => {
    const box = (await target.boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const x = box.x + box.width / 2
    const y = box.y + box.height * 0.4
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: at, y }],
      })
    await touch("touchStart", x)
    for (let step = 1; step <= 10; step++)
      await touch("touchMove", x + (dx * step) / 10)
    await touch("touchEnd", x + dx)
    await cdp.detach()
  }

  test("the charts stack full width with tabs below them, and a finger drag pans both charts", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const code = freshCode("PH")
    const now = marketNow()
    // 20 minutes up to now: enough bars to pan.
    await relay.sendAjaib(
      Array.from({ length: 20 }, (_, index) =>
        ajaibTradeToday({
          seq: base + index + 1,
          time: wibTime(now - (19 - index) * 60_000),
          ticker: code,
          price: 500 + (index % 4) * 5,
          lot: 100,
          type: index % 2 === 0 ? "SELL" : "BUY",
        })
      )
    )
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    const chart = page.getByRole("region", { name: "Chart" })
    const footprint = page.getByRole("region", { name: "Footprint" })
    await expect(footprint).toContainText("Footprint minutes: 20")
    const chart1 = page.locator('[data-chart="candles"]')
    const chart2 = page.locator('[data-chart="footprint"]')

    // Chart 1, then chart 2, each across the page.
    const box1 = (await chart1.boundingBox())!
    const box2 = (await chart2.boundingBox())!
    expect(box1.width).toBeGreaterThan(300)
    expect(Math.abs(box2.width - box1.width)).toBeLessThan(2)
    expect(box2.y).toBeGreaterThan(box1.y + box1.height)

    // The top-N control and the footprint tabs wrap under their titles.
    const below = async (lower: Locator, upper: Locator) => {
      const [a, b] = [
        (await lower.boundingBox())!,
        (await upper.boundingBox())!,
      ]
      return a.y >= b.y + b.height
    }
    expect(
      await below(
        chart.getByLabel("Top N percent of sweeps"),
        chart.getByRole("heading", { name: code })
      )
    ).toBe(true)
    expect(
      await below(
        footprint.getByRole("tablist", { name: "Footprint view" }),
        footprint.getByRole("heading", { name: "Footprint" })
      )
    ).toBe(true)

    // Below the charts, one tab at a time: Sweeps first.
    const tabs = page.getByRole("tablist", { name: "Panels" })
    await expect(tabs.getByRole("tab")).toHaveText([
      "Sweeps",
      "Watchlist",
      "Order book",
      "Tape",
    ])
    expect((await tabs.boundingBox())!.y).toBeGreaterThan(box2.y + box2.height)
    const panels = {
      Sweeps: page.getByRole("region", { name: "Sweep log" }),
      Watchlist: page.getByRole("region", { name: "Watchlist" }),
      "Order book": page.getByRole("region", { name: "Order book" }),
      Tape: page.getByRole("region", { name: "Running trades" }),
    }
    const shows = async (name: keyof typeof panels) => {
      await expect(tabs.getByRole("tab", { name })).toHaveAttribute(
        "aria-selected",
        "true"
      )
      for (const [other, panel] of Object.entries(panels))
        if (other === name) await expect(panel).toBeVisible()
        else await expect(panel).toBeHidden()
    }
    await shows("Sweeps")
    for (const name of ["Watchlist", "Order book", "Tape"] as const) {
      await tabs.getByRole("tab", { name }).click()
      await shows(name)
    }
    // The tab is in the URL, so a shared link opens on it.
    await expect(page).toHaveURL(/[?&]panel=tape(&|$)/)

    // A finger dragged across chart 1 pans chart 2 by the same minutes.
    const range = async (host: Locator) => ({
      from: Number(await host.getAttribute("data-from")),
      to: Number(await host.getAttribute("data-to")),
    })
    const settled = async () => {
      let last = ""
      await expect
        .poll(
          async () => {
            const current = JSON.stringify([
              await range(chart1),
              await range(chart2),
            ])
            const still = current === last
            last = current
            return still
          },
          { intervals: [250] }
        )
        .toBe(true)
      return [await range(chart1), await range(chart2)] as const
    }
    await expect.poll(async () => (await range(chart2)).to).toBeGreaterThan(0)
    const [opened1, opened2] = await settled()
    await chart1.scrollIntoViewIfNeeded()
    await touchDrag(page, chart1, 150)
    await expect
      .poll(async () => (await range(chart1)).from)
      .toBeLessThan(opened1.from - 1)
    await expect
      .poll(async () => {
        const [one, two] = await Promise.all([range(chart1), range(chart2)])
        return Math.abs(two.from - opened2.from - (one.from - opened1.from))
      })
      .toBeLessThan(0.05)

    // And a finger on chart 2 pans chart 1.
    const [dragged1, dragged2] = await settled()
    await chart2.scrollIntoViewIfNeeded()
    await touchDrag(page, chart2, -150)
    await expect
      .poll(async () => (await range(chart2)).from)
      .toBeGreaterThan(dragged2.from + 1)
    await expect
      .poll(async () => {
        const [one, two] = await Promise.all([range(chart1), range(chart2)])
        return Math.abs(one.from - dragged1.from - (two.from - dragged2.from))
      })
      .toBeLessThan(0.05)

    await page.reload()
    await shows("Tape")
    relay.close()
  })
})
