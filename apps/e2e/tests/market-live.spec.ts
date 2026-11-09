import { DASHBOARD, MEMBER } from "../support/accounts"
import { signInUrl } from "../support/flows"
import {
  ajaibTradeToday,
  openIngest,
  openingMatchToday,
  session1Today,
} from "../support/ingest"
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

test.describe("the tape at peak", () => {
  test.use({ storageState: MEMBER.storageState })

  test("the 08:58 match folds into one row while the page holds smooth frames", async ({
    page,
  }) => {
    const relay = await openIngest()
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const fold = tape.getByRole("button", { name: /Opening match 08:58:00/ })
    // The first print, once the page's socket is live: a snapshot carries
    // only the 200 newest trades, so the replay waits for it.
    const match = openingMatchToday(20_000)
    await relay.sendAjaib(match.slice(0, 1))
    await expect(fold).toContainText("1 trade ·")
    // Every animation frame's length from here until the match is in.
    await page.evaluate(() => {
      const frames: Array<number> = []
      Object.assign(window, { tapeFrames: frames })
      let last = performance.now()
      const tick = (now: number) => {
        frames.push(now - last)
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    // The rest in 250 ms batches of 1,278, the peak delta measured on
    // 2026-11-09.
    for (let at = 1; at < match.length; at += 1_278) {
      await relay.sendAjaib(match.slice(at, at + 1_278))
      await page.waitForTimeout(250)
    }
    await expect(fold).toContainText("20,000 trades", { timeout: 30_000 })
    await expect(fold).toContainText("676 codes")
    const frames = await page.evaluate(() =>
      (window as unknown as { tapeFrames: Array<number> }).tapeFrames
        .slice(1)
        .sort((a, b) => a - b)
    )
    const p99 = frames[Math.floor(frames.length * 0.99)]!
    expect(p99, `p99 of ${frames.length} frames`).toBeLessThan(50)

    // Expanded, the fold lists its prints newest first, without a side.
    await expect(fold).toHaveAttribute("aria-expanded", "false")
    await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "true")
    const newest = tape.locator('tr[data-trade-number="20000"]')
    await expect(newest).toContainText("08:58:00")
    await expect(newest).not.toContainText(/buy|sell/)
    relay.close()
  })

  test("rows show side, big trades, boards and the selected code", async ({
    page,
  }) => {
    const relay = await openIngest()
    const at = { time: "10:00:01", price: 5_000 }
    await relay.sendAjaib([
      ajaibTradeToday({ ...at, seq: 900_001, ticker: "BBCA", lot: 5 }),
      // 5,000 × 2,000 lots × 100 = Rp1 B: a big trade.
      ajaibTradeToday({
        ...at,
        seq: 900_002,
        ticker: "TLKM",
        lot: 2_000,
        type: "SELL",
      }),
      ajaibTradeToday({
        ...at,
        seq: 900_003,
        ticker: "ASII",
        lot: 1,
        board: "TN",
      }),
      // Negotiated: no side, and never big.
      ajaibTradeToday({
        ...at,
        seq: 900_004,
        ticker: "BBRI",
        lot: 5_000,
        board: "NG",
      }),
    ])
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (seq: number) => tape.locator(`tr[data-trade-number="${seq}"]`)
    const price = (seq: number) => row(seq).locator("td").nth(2)
    const up = "rgb(81, 221, 162)"
    const down = "rgb(255, 121, 135)"

    // BBCA is the selected code: highlighted, a buy in green.
    await expect(row(900_001)).toHaveCSS("background-color", "rgb(23, 58, 67)")
    await expect(price(900_001)).toHaveCSS("color", up)
    await expect(price(900_001)).toContainText("buy")

    await expect(row(900_002)).toHaveCSS("font-weight", "700")
    // The 3 px edge bar, last in Tailwind's stack of empty ring shadows.
    await expect(row(900_002)).toHaveCSS(
      "box-shadow",
      /rgb\(255, 121, 135\) 3px 0px 0px 0px inset$/
    )
    await expect(price(900_002)).toHaveCSS("color", down)
    await expect(price(900_002)).toContainText("sell")
    await expect(row(900_002)).toContainText("Rp1 B")

    await expect(row(900_003)).toContainText("ASIITN")
    await expect(price(900_003)).toHaveCSS("color", up)

    await expect(row(900_004)).toContainText("BBRING")
    await expect(row(900_004)).not.toContainText(/buy|sell/)
    await expect(row(900_004)).toHaveCSS("font-weight", "400")
    relay.close()
  })

  test("scrolled down, the tape freezes and counts new trades until the pill returns it to live", async ({
    page,
  }) => {
    const relay = await openIngest()
    const trades = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        ajaibTradeToday({
          seq: from + i,
          time: "10:00:02",
          ticker: "FRZA",
          price: 100,
          lot: 1,
        })
      )
    await relay.sendAjaib(trades(910_001, 100))
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (seq: number) => tape.locator(`tr[data-trade-number="${seq}"]`)
    await expect(row(910_100)).toBeVisible()

    await tape.getByRole("table").hover()
    await page.mouse.wheel(0, 600)
    await expect(row(910_100)).not.toBeInViewport()
    await relay.sendAjaib(trades(910_101, 30))
    const pill = tape.getByRole("button", { name: "30 new trades ↑" })
    await expect(pill).toBeVisible()
    await expect(row(910_130)).toHaveCount(0)

    await pill.click()
    await expect(row(910_130)).toBeInViewport()
    await expect(pill).toBeHidden()
    relay.close()
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
