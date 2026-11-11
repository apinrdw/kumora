import { DASHBOARD, MEMBER } from "../support/accounts"
import { signInUrl } from "../support/flows"
import {
  ajaibTradeToday,
  freshTradeNumbers,
  openIngest,
  openSilentIngest,
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
    const base = freshTradeNumbers()
    const frames = session1Today(base)
    // Before the page opens: the snapshot carries these.
    await relay.sendAjaib(frames.slice(0, 10))
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    // A recorded trade number, as this test renumbered it.
    const row = (recorded: number) =>
      tape.locator(`tr[data-trade-number="${base + recorded}"]`)
    await expect(row(22265)).toContainText("BREN")
    await expect(row(22265)).toContainText("09:00:00")
    await expect(row(22265)).toContainText("2,130")
    // One dot for the one feed that saw it, explained by the header legend.
    await expect(row(22265).getByRole("img")).toHaveAccessibleName("Ajaib")
    await expect(
      tape.getByRole("list", { name: "Sources" }).getByRole("listitem")
    ).toHaveText(["Stockbit", "Ajaib", "Backfill"])

    // After: a delta. 22266 arrives late and sorts below 22268.
    await relay.sendAjaib(frames.slice(10, 20))
    await expect(row(22266)).toBeVisible()
    const numbers = await tape
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.map((r) => r.getAttribute("data-trade-number"))
      )
    expect(numbers.indexOf(String(base + 22266))).toBeGreaterThan(
      numbers.indexOf(String(base + 22268))
    )
    relay.close()
  })

  test("the selected code's candles draw on the chart as trades arrive", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    // A code of its own, so its candles are this test's alone, a repeat's
    // too: today's object keeps every code's candles. The recorded session
    // has none, so two trades are made from its first frame, a minute apart.
    const code = `CN${Date.now().toString(36).toUpperCase()}`
    const [template] = session1Today()
    const trade = JSON.parse(template!)
    const tradeAt = (sequence: number, price: number, minutes: number) =>
      JSON.stringify({
        ...trade,
        ticker: code,
        price,
        tradeNum: `${trade.tradeNum.slice(0, 8)}${String(base + sequence).padStart(10, "0")}`,
        tradedAt: new Date(
          Date.parse(trade.tradedAt) + minutes * 60_000
        ).toISOString(),
      })
    await relay.sendAjaib([tradeAt(1, 9275, 0)])
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    const chart = page.getByRole("region", { name: "Chart" })
    await expect(chart.getByRole("heading", { name: code })).toBeVisible()
    await expect(chart).toContainText("One-minute candles: 1")
    await expect(chart).toContainText("9,275")
    await expect(chart.locator("canvas").first()).toBeVisible()
    await expect(
      chart.getByRole("link", { name: "TradingView Lightweight Charts™" })
    ).toHaveAttribute("href", "https://www.tradingview.com/")

    // A delta: the next minute opens its own candle.
    await relay.sendAjaib([tradeAt(2, 9300, 1)])
    await expect(chart).toContainText("One-minute candles: 2")
    await expect(chart).toContainText("9,300")
    relay.close()
  })

  test("a feed drop flips its pill, and both down dims the tape with STALE", async ({
    page,
  }) => {
    const relay = await openIngest()
    await relay.sendAjaib(session1Today(freshTradeNumbers()).slice(0, 5))
    await relay.report("Stockbit", "alive")
    await page.goto(`${DASHBOARD}${PAGE}`)
    const conditions = page.getByRole("group", { name: "Market conditions" })
    const pill = (feed: string) =>
      conditions.getByRole("listitem").filter({ hasText: feed })
    const tape = page.getByRole("region", { name: "Running trades" })
    // The Test stage's clock offset puts the market in session 1.
    await expect(conditions.getByLabel("Market phase")).toHaveText("Session 1")
    await expect(pill("Stockbit")).toContainText("LIVE")
    await expect(pill("Ajaib")).toContainText("LIVE")
    // The morning before the first relay connected wasn't recorded.
    await expect(tape.locator("tr[data-relay-gap]").first()).toContainText(
      "Not recorded"
    )

    await relay.report("Stockbit", "closed")
    await expect(pill("Stockbit")).toContainText("UNAVAILABLE")
    await expect(pill("Ajaib")).toContainText("LIVE")
    await expect(tape).not.toHaveAttribute("data-stale")

    await relay.report("Ajaib", "closed")
    await expect(pill("Ajaib")).toContainText("UNAVAILABLE")
    await expect(tape).toHaveAttribute("data-stale", "true")
    await expect(
      tape.getByRole("heading", { name: /Running trades/ })
    ).toContainText("STALE")
    for (const name of ["Chart", "Watchlist", "Order book"])
      await expect(page.getByRole("region", { name })).toHaveAttribute(
        "data-stale",
        "true"
      )
    // The last trades stay on screen.
    await expect(tape.locator("tr[data-trade-number]").first()).toBeVisible()
    relay.close()
  })

  test("a dropped page socket shows Reconnecting… without blaming the feeds", async ({
    page,
  }) => {
    // The page's socket goes through Playwright: the test drops it, then
    // refuses reconnects until it lets one through.
    let accept = true
    let dropPage: (() => void) | undefined
    await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
      if (!accept) return socket.close({ code: 1012, reason: "Restart" })
      socket.connectToServer()
      dropPage = () => {
        accept = false
        void socket.close({ code: 1012, reason: "Restart" })
      }
    })
    await page.goto(`${DASHBOARD}${PAGE}`)
    const conditions = page.getByRole("group", { name: "Market conditions" })
    await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible()
    await expect.poll(() => dropPage !== undefined).toBe(true)
    dropPage!()
    await expect(conditions.getByRole("status")).toHaveText("Reconnecting…")
    await expect(conditions.getByRole("list", { name: "Feeds" })).toBeHidden()
    await expect(
      page.getByRole("region", { name: "Running trades" })
    ).toHaveAttribute("data-stale", "true")
    // The reconnect's fresh snapshot brings the pills back.
    accept = true
    await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible({
      timeout: 15_000,
    })
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
    const base = freshTradeNumbers()
    // A snapshot carries only the 200 newest trades. Today's object keeps an
    // earlier run's match prints, so 200 continuous trades above them keep
    // those out of the page's snapshot, and the fold counts this run's alone.
    const newer = 200
    await relay.sendAjaib(
      Array.from({ length: newer }, (_, i) =>
        ajaibTradeToday({
          seq: base + i + 1,
          time: "10:00:03",
          ticker: "PSTM",
          price: 100,
          lot: 1,
        })
      )
    )
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    await expect(
      tape.locator(`tr[data-trade-number="${base + newer}"]`)
    ).toBeVisible()
    const fold = tape.getByRole("button", { name: /Opening match 08:58:00/ })
    // The first print, once the page's socket is live, so the replay waits
    // for the snapshot.
    const match = openingMatchToday(20_000, base + newer)
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
    const newest = tape.locator(
      `tr[data-trade-number="${base + newer + 20_000}"]`
    )
    await expect(newest).toContainText("08:58:00")
    await expect(newest).not.toContainText(/buy|sell/)
    relay.close()
  })

  test("rows show side, big trades, boards and the selected code", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const at = { time: "10:00:01", price: 5_000 }
    await relay.sendAjaib([
      ajaibTradeToday({ ...at, seq: base + 1, ticker: "BBCA", lot: 5 }),
      // 5,000 × 2,000 lots × 100 = Rp1 B: a big trade.
      ajaibTradeToday({
        ...at,
        seq: base + 2,
        ticker: "TLKM",
        lot: 2_000,
        type: "SELL",
      }),
      ajaibTradeToday({
        ...at,
        seq: base + 3,
        ticker: "ASII",
        lot: 1,
        board: "TN",
      }),
      // Negotiated: no side, and never big.
      ajaibTradeToday({
        ...at,
        seq: base + 4,
        ticker: "BBRI",
        lot: 5_000,
        board: "NG",
      }),
    ])
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (n: number) =>
      tape.locator(`tr[data-trade-number="${base + n}"]`)
    const price = (n: number) => row(n).locator("td").nth(2)
    const up = "rgb(81, 221, 162)"
    const down = "rgb(255, 121, 135)"

    // BBCA is the selected code: highlighted, a buy in green.
    await expect(row(1)).toHaveCSS("background-color", "rgb(23, 58, 67)")
    await expect(price(1)).toHaveCSS("color", up)
    await expect(price(1)).toContainText("buy")

    await expect(row(2)).toHaveCSS("font-weight", "700")
    // The 3 px edge bar, last in Tailwind's stack of empty ring shadows.
    await expect(row(2)).toHaveCSS(
      "box-shadow",
      /rgb\(255, 121, 135\) 3px 0px 0px 0px inset$/
    )
    await expect(price(2)).toHaveCSS("color", down)
    await expect(price(2)).toContainText("sell")
    await expect(row(2)).toContainText("Rp1 B")

    await expect(row(3)).toContainText("ASIITN")
    await expect(price(3)).toHaveCSS("color", up)

    await expect(row(4)).toContainText("BBRING")
    await expect(row(4)).not.toContainText(/buy|sell/)
    await expect(row(4)).toHaveCSS("font-weight", "400")
    relay.close()
  })

  test("scrolled down, the tape freezes and counts new trades until the pill returns it to live", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const trades = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        ajaibTradeToday({
          seq: base + from + i,
          time: "10:00:02",
          ticker: "FRZA",
          price: 100,
          lot: 1,
        })
      )
    await relay.sendAjaib(trades(1, 100))
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (n: number) =>
      tape.locator(`tr[data-trade-number="${base + n}"]`)
    await expect(row(100)).toBeVisible()

    await tape.getByRole("table").hover()
    await page.mouse.wheel(0, 600)
    await expect(row(100)).not.toBeInViewport()
    await relay.sendAjaib(trades(101, 30))
    const pill = tape.getByRole("button", { name: "30 new trades ↑" })
    await expect(pill).toBeVisible()
    await expect(row(130)).toHaveCount(0)

    await pill.click()
    await expect(row(130)).toBeInViewport()
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

test("an ingest socket that sends no token is closed with 4408", async () => {
  // Between 10 and 20 s after it opened, at the trading-day object's alarm.
  test.setTimeout(25_000)
  const silent = await openSilentIngest()
  expect(await silent.closed).toBe(4408)
})
