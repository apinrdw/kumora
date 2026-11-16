import { DASHBOARD, MEMBER } from "../support/accounts"
import { volumeInk } from "../support/chart"
import { marketNow, wibTime } from "../support/clock"
import { signInUrl } from "../support/flows"
import {
  ajaibTradeToday,
  freshCode,
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
    await expect(row(22265)).toContainText(
      wibTime(Date.parse(JSON.parse(frames[0]!).tradedAt))
    )
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
    const code = freshCode("CN")
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

  test("the footprint chart draws the selected code's footprint cells and footer as trades arrive", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    // A code of its own: today's object keeps every code's footprints.
    const code = freshCode("FP")
    const sentAt = marketNow()
    const time = wibTime(sentAt)
    await relay.sendAjaib([
      ajaibTradeToday({
        seq: base + 1,
        time,
        ticker: code,
        price: 500,
        lot: 3,
      }),
      ajaibTradeToday({
        seq: base + 2,
        time,
        ticker: code,
        price: 505,
        lot: 2,
        type: "SELL",
      }),
    ])
    // A desktop's width: 10 minutes of the footprint chart then read as text.
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    const footprint = page.getByRole("region", { name: "Footprint" })
    const minute = (at: number) => `${wibTime(at).slice(0, 5)}:00`
    // 3 lots bought at 500, 2 sold at 505.
    await expect(footprint).toContainText(
      `Footprint minutes: 1. ${minute(sentAt)}: Vol 5, Δ +1, CVD +1`
    )
    // The opening window is 10 minutes wide: each reads as `sell × buy`
    // text, with a labelled footer.
    const canvas = footprint.locator('[data-chart="footprint"]')
    await expect(canvas).toHaveAttribute("data-draw-mode", "text")
    await expect(canvas).toHaveAttribute("data-footer", "labelled")

    // A delta: the next minute's sell runs CVD below zero.
    const next = sentAt + 60_000
    await relay.sendAjaib([
      ajaibTradeToday({
        seq: base + 3,
        time: wibTime(next),
        ticker: code,
        price: 500,
        lot: 4,
        type: "SELL",
      }),
    ])
    await expect(footprint).toContainText(
      `Footprint minutes: 2. ${minute(next)}: Vol 4, Δ −4, CVD −3`
    )
    relay.close()
  })

  test("the footprint chart opens on 10 minutes, pans with the candle chart both ways, zooms alone and shows a ladder of exact lots", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const code = freshCode("NV")
    const now = marketNow()
    // 20 minutes up to now, each 12,345 lots sold and 1,500 bought.
    await relay.sendAjaib(
      Array.from({ length: 20 }, (_, index) => {
        const time = wibTime(now - (19 - index) * 60_000)
        const price = 500 + (index % 4) * 5
        return [
          ajaibTradeToday({
            seq: base + 2 * index + 1,
            time,
            ticker: code,
            price,
            lot: 12_345,
            type: "SELL",
          }),
          ajaibTradeToday({
            seq: base + 2 * index + 2,
            time,
            ticker: code,
            price: price + 5,
            lot: 1_500,
          }),
        ]
      }).flat()
    )
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    const footprint = page.getByRole("region", { name: "Footprint" })
    await expect(footprint).toContainText("Footprint minutes: 20")
    const candleChart = page.locator('[data-chart="candles"]')
    const footprintChart = page.locator('[data-chart="footprint"]')
    // Each chart's visible logical range, in bars.
    const range = async (chart: typeof candleChart) => {
      const [from, to] = await Promise.all([
        chart.getAttribute("data-from"),
        chart.getAttribute("data-to"),
      ])
      return { from: Number(from), to: Number(to) }
    }
    const width = async (chart: typeof candleChart) => {
      const { from, to } = await range(chart)
      return to - from
    }

    // Both charts' ranges, once neither has moved for a moment: a pan is
    // measured from there.
    const settled = async () => {
      let last = ""
      await expect
        .poll(
          async () => {
            const current = JSON.stringify([
              await range(candleChart),
              await range(footprintChart),
            ])
            const still = current === last
            last = current
            return still
          },
          { intervals: [250] }
        )
        .toBe(true)
      return [await range(candleChart), await range(footprintChart)] as const
    }

    // Exactly 10 whole minutes: a range 9 bars wide.
    await expect.poll(() => width(footprintChart)).toBe(9)
    const [opened1, opened2] = await settled()
    expect(Number.isInteger(opened2.from)).toBe(true)

    // Dragging the candle chart moves the footprint chart by the same minutes,
    // and back.
    const box1 = (await candleChart.boundingBox())!
    const drag = async (dx: number) => {
      const y = box1.y + box1.height * 0.4
      await page.mouse.move(box1.x + box1.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(box1.x + box1.width / 2 + dx, y, { steps: 8 })
      await page.mouse.up()
    }
    await drag(240)
    await expect
      .poll(async () => (await range(candleChart)).from)
      .toBeLessThan(opened1.from - 1)
    await expect
      .poll(async () => {
        const [one, two] = await Promise.all([
          range(candleChart),
          range(footprintChart),
        ])
        return Math.abs(two.from - opened2.from - (one.from - opened1.from))
      })
      .toBeLessThan(0.05)
    await drag(-240)
    await expect
      .poll(async () => (await range(footprintChart)).from.toFixed(1))
      .toBe(opened2.from.toFixed(1))
    expect((await range(candleChart)).from).toBeCloseTo(opened1.from, 1)

    // A horizontal wheel on the candle chart pans the footprint chart too, and
    // back.
    await page.mouse.wheel(-150, 0)
    await page.mouse.wheel(-150, 0)
    await expect
      .poll(async () => (await range(candleChart)).from)
      .toBeLessThan(opened1.from - 1)
    await expect
      .poll(async () => {
        const [one, two] = await Promise.all([
          range(candleChart),
          range(footprintChart),
        ])
        return Math.abs(two.from - opened2.from - (one.from - opened1.from))
      })
      .toBeLessThan(0.05)
    await page.mouse.wheel(300, 0)
    await expect
      .poll(async () => (await range(footprintChart)).from.toFixed(1))
      .toBe(opened2.from.toFixed(1))

    // Hovering a minute on the footprint chart: its ladder of exact lots.
    const box2 = (await footprintChart.boundingBox())!
    await page.mouse.move(box2.x + (box2.width - 72) / 2, box2.y + 120)
    const ladder = page.getByRole("tooltip", { name: "Footprint ladder" })
    await expect(ladder).toContainText("12,345")
    await expect(ladder).toContainText("1,500")
    await expect(ladder).toContainText("Vol13,845")
    await expect(ladder).toContainText("Δ−10,845")
    await expect(ladder.locator("tr[data-here]")).toHaveCount(1)

    // Dragging the footprint chart moves the candle chart by the same minutes.
    const [dragged1, dragged2] = await settled()
    const y2 = box2.y + 120
    await page.mouse.move(box2.x + box2.width / 2, y2)
    await page.mouse.down()
    await page.mouse.move(box2.x + box2.width / 2 + 300, y2, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await range(footprintChart)).from)
      .toBeLessThan(dragged2.from - 1)
    await expect
      .poll(async () => {
        const [one, two] = await Promise.all([
          range(candleChart),
          range(footprintChart),
        ])
        return Math.abs(one.from - dragged1.from - (two.from - dragged2.from))
      })
      .toBeLessThan(0.05)

    // The wheel zooms the footprint chart alone.
    const before1 = await range(candleChart)
    await page.mouse.wheel(0, -600)
    await expect.poll(() => width(footprintChart)).toBeLessThan(9)
    expect(await range(candleChart)).toEqual(before1)

    // A click on the candle chart jumps the footprint chart there, back at 10
    // minutes.
    await page.mouse.click(box1.x + box1.width * 0.6, box1.y + box1.height / 2)
    await expect.poll(() => width(footprintChart)).toBe(9)
    relay.close()
  })

  test("a new minute scrolls the candle chart on and leaves the footprint chart where it was dragged, the pointer resting on the candle chart", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const code = freshCode("NM")
    const now = marketNow()
    const trade = (seq: number, at: number) =>
      ajaibTradeToday({
        seq: base + seq,
        time: wibTime(at),
        ticker: code,
        price: 500,
        lot: 10,
      })
    // 20 minutes up to now.
    await relay.sendAjaib(
      Array.from({ length: 20 }, (_, index) =>
        trade(index + 1, now - (19 - index) * 60_000)
      )
    )
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    await expect(page.getByRole("region", { name: "Footprint" })).toContainText(
      "Footprint minutes: 20"
    )
    const candleChart = page.locator('[data-chart="candles"]')
    const footprintChart = page.locator('[data-chart="footprint"]')
    const range = async (chart: typeof candleChart) => ({
      from: Number(await chart.getAttribute("data-from")),
      to: Number(await chart.getAttribute("data-to")),
    })
    // Both charts' ranges, once neither has moved for a moment.
    const settled = async () => {
      let last = ""
      await expect
        .poll(
          async () => {
            const current = JSON.stringify([
              await range(candleChart),
              await range(footprintChart),
            ])
            const still = current === last
            last = current
            return still
          },
          { intervals: [250] }
        )
        .toBe(true)
      return [await range(candleChart), await range(footprintChart)] as const
    }
    await expect
      .poll(async () => {
        const { from, to } = await range(footprintChart)
        return to - from
      })
      .toBe(9)
    const [, opened2] = await settled()

    // The footprint chart dragged back, its newest minute out of view; then the
    // pointer rests on the candle chart.
    const box1 = (await candleChart.boundingBox())!
    const box2 = (await footprintChart.boundingBox())!
    await page.mouse.move(box2.x + box2.width / 2, box2.y + 120)
    await page.mouse.down()
    await page.mouse.move(box2.x + box2.width / 2 + 300, box2.y + 120, {
      steps: 8,
    })
    await page.mouse.up()
    await expect
      .poll(async () => (await range(footprintChart)).from)
      .toBeLessThan(opened2.from - 1)
    await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height * 0.4)
    const [rested1, rested2] = await settled()

    // A minute after every one drawn: the candle chart scrolls on a bar by
    // itself.
    await relay.sendAjaib([trade(21, now + 2 * 60_000)])
    await expect
      .poll(async () => (await range(candleChart)).from)
      .toBeCloseTo(rested1.from + 1, 1)
    expect((await settled())[1]).toEqual(rested2)
    relay.close()
  })

  test("the candle chart's volume pane splits each minute into buy and sell lots", async ({
    page,
  }) => {
    const relay = await openIngest()
    const base = freshTradeNumbers()
    const code = freshCode("VP")
    const time = wibTime(marketNow())
    // 3 lots bought, then 2 sold, in one minute.
    await relay.sendAjaib([
      ajaibTradeToday({
        seq: base + 1,
        time,
        ticker: code,
        price: 500,
        lot: 3,
      }),
      ajaibTradeToday({
        seq: base + 2,
        time,
        ticker: code,
        price: 495,
        lot: 2,
        type: "SELL",
      }),
    ])
    await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
    await expect(page.getByText("One-minute candles: 1")).toBeAttached()
    const chart = page.locator('[data-chart="candles"]')
    // Its bar is green at the bottom and red above, 3 lots to 2: more
    // green than red.
    await expect
      .poll(async () => {
        const ink = await volumeInk(chart)
        return ink.sell > 0 && ink.buy > ink.sell
      })
      .toBe(true)
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
    // earlier run's auction match trades, so 200 continuous trades above them keep
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
    // The auction match's first running trade, once the page's socket is live, so the replay waits
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
    // Now on the market clock: every relay that closed before this test left
    // a relay gap (its "Not recorded" row), drawn above any trade older than it, and enough
    // of them would push this test's trades out of view.
    const time = wibTime(marketNow())
    const trades = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        ajaibTradeToday({
          seq: base + from + i,
          time,
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
