import { DASHBOARD, MEMBER } from "../support/accounts"
import { signInUrl } from "../support/flows"
import { openIngest, session1Today } from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.describe("signed in", () => {
  test.use({ storageState: MEMBER.storageState })

  test("Ajaib trades from the relay reach the tape, ordered by trade number", async ({
    page,
  }) => {
    const relay = await openIngest()
    const frames = session1Today()
    // Before the page opens: the snapshot carries these.
    await relay.sendAjaib(frames.slice(0, 10))
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (tradeNumber: string) =>
      tape.locator(`tr[data-trade-number="${tradeNumber}"]`)
    await expect(row("22265")).toContainText("BREN")
    await expect(row("22265")).toContainText("09:00:00")
    await expect(row("22265")).toContainText("2,130")
    // One dot for the one feed that saw it, explained by the header legend.
    await expect(row("22265").getByRole("img")).toHaveAccessibleName("Ajaib")
    await expect(
      tape.getByRole("list", { name: "Sources" }).getByRole("listitem")
    ).toHaveText(["Stockbit", "Ajaib", "Backfill"])

    // After: a delta. 22266 arrives late and sorts below 22268.
    await relay.sendAjaib(frames.slice(10, 20))
    await expect(row("22266")).toBeVisible()
    const numbers = await tape
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.map((r) => r.getAttribute("data-trade-number"))
      )
    expect(numbers.indexOf("22266")).toBeGreaterThan(numbers.indexOf("22268"))
    relay.close()
  })

  test("the selected code's candles draw on the chart as trades arrive", async ({
    page,
  }) => {
    const relay = await openIngest()
    // The page selects BBCA; the recorded session has none, so two BBCA
    // trades are made from its first frame, a minute apart.
    const [template] = session1Today()
    const trade = JSON.parse(template!)
    const bbca = (sequence: number, price: number, minutes: number) =>
      JSON.stringify({
        ...trade,
        ticker: "BBCA",
        price,
        tradeNum: `${trade.tradeNum.slice(0, 8)}${String(sequence).padStart(10, "0")}`,
        tradedAt: new Date(
          Date.parse(trade.tradedAt) + minutes * 60_000
        ).toISOString(),
      })
    await relay.sendAjaib([bbca(90_001, 9275, 0)])
    await page.goto(`${DASHBOARD}${PAGE}`)
    const chart = page.getByRole("region", { name: "Chart" })
    await expect(chart.getByRole("heading", { name: "BBCA" })).toBeVisible()
    await expect(chart).toContainText("One-minute candles: 1")
    await expect(chart).toContainText("9,275")
    await expect(chart.locator("canvas").first()).toBeVisible()
    await expect(
      chart.getByRole("link", { name: "TradingView Lightweight Charts™" })
    ).toHaveAttribute("href", "https://www.tradingview.com/")

    // A delta: the next minute opens its own candle.
    await relay.sendAjaib([bbca(90_002, 9300, 1)])
    await expect(chart).toContainText("One-minute candles: 2")
    await expect(chart).toContainText("9,300")
    relay.close()
  })

  test("the nav leads to Market Live", async ({ page }) => {
    await page.goto(`${DASHBOARD}/account`)
    await page.getByRole("link", { name: "Market Live" }).first().click()
    await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  })

  test("a signed-out reconnect closes with 4401 and lands on sign-in", async ({
    page,
    context,
  }) => {
    // The page's socket goes through Playwright, so the test can drop it.
    let dropPage: (() => void) | undefined
    await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
      const server = socket.connectToServer()
      dropPage = () => socket.close({ code: 1012, reason: "Restart" })
      void server
    })
    await page.goto(`${DASHBOARD}${PAGE}`)
    await expect(
      page.getByRole("heading", { name: "Running trades" })
    ).toBeVisible()
    await expect.poll(() => dropPage !== undefined).toBe(true)
    await page.unrouteAll()
    await context.clearCookies()
    dropPage!()
    await expect(page).toHaveURL(signInUrl(PAGE), { timeout: 15_000 })
  })

  test("a 4426 close asks for a reload", async ({ page }) => {
    await page.routeWebSocket(/\/market-live\/live$/, (socket) =>
      socket.close({ code: 4426, reason: "New version, reload" })
    )
    await page.goto(`${DASHBOARD}${PAGE}`)
    await expect(page.getByRole("alert")).toContainText("Reload to continue")
  })
})

test("a signed-out visit goes to sign-in, keeping the page", async ({
  page,
}) => {
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page).toHaveURL(signInUrl(PAGE))
})

test("a wrong ingest token closes the ingest socket with 4403", async () => {
  const relay = await openIngest("not the token")
  expect(await relay.closed).toBe(4403)
})
